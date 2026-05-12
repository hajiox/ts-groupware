#!/usr/bin/env python3
"""TSG君システムアカウント作成 + Excelダミー投稿一括登録"""
import sys, json, urllib.request, uuid, openpyxl
sys.stdout.reconfigure(encoding='utf-8')

SUPABASE_URL = "https://zfhswguzqyagmhhlpksq.supabase.co"
SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmaHN3Z3V6cXlhZ21oaGxwa3NxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Mjc3MjY3MiwiZXhwIjoyMDg4MzQ4NjcyfQ.actrbqYaVALBa12b3XLe_0gAbodKLd_ANukBs_GWYtk"

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

EXCEL_PATH = r"C:\作業用\facebook_groups_2026-05-12.xlsx"

def api_get(path):
    req = urllib.request.Request(f"{SUPABASE_URL}/rest/v1/{path}", headers=HEADERS)
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())

def api_post(path, data):
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(f"{SUPABASE_URL}/rest/v1/{path}", data=body, headers=HEADERS, method="POST")
    try:
        resp = urllib.request.urlopen(req)
        return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8")
        print(f"  ERROR {e.code}: {err}")
        return None

def api_patch(path, data):
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(f"{SUPABASE_URL}/rest/v1/{path}", data=body, headers=HEADERS, method="PATCH")
    try:
        resp = urllib.request.urlopen(req)
        return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8")
        print(f"  ERROR {e.code}: {err}")
        return None


# === Step 1: TSG君 システムアカウント作成 ===
def create_tsg_user():
    print("=== Step 1: TSG君 システムアカウント作成 ===")

    # 既存チェック
    existing = api_get("gw_users?display_name=eq.TSG%E5%90%9B&select=id,display_name,role")
    if existing:
        print(f"  既存: TSG君 ({existing[0]['id'][:8]}...) role={existing[0]['role']}")
        # 管理者でなければ昇格
        if existing[0]['role'] != 'admin':
            api_patch(f"gw_users?id=eq.{existing[0]['id']}", {"role": "admin"})
            print("  -> 管理者に昇格しました")
        return existing[0]['id']

    # 新規作成 - line_user_id はシステム用に一意のIDを生成
    tsg_id = str(uuid.uuid4())
    system_line_id = f"system_tsg_{tsg_id[:8]}"
    
    result = api_post("gw_users", {
        "id": tsg_id,
        "line_user_id": system_line_id,
        "display_name": "TSG君",
        "picture_url": None,
        "role": "admin",
    })
    
    if result:
        print(f"  作成完了: TSG君 ({result[0]['id'][:8]}...) role=admin")
        return result[0]['id']
    else:
        print("  ERROR: TSG君の作成に失敗")
        return None


# === Step 2: TSG君を全グループにメンバー追加 ===
def add_to_all_groups(tsg_id):
    print("\n=== Step 2: TSG君を全グループにメンバー追加 ===")
    groups = api_get("gw_groups?select=id,name")
    
    existing_memberships = api_get(f"gw_group_members?user_id=eq.{tsg_id}&select=group_id")
    existing_group_ids = {m['group_id'] for m in existing_memberships}
    
    added = 0
    for g in groups:
        if g['id'] in existing_group_ids:
            continue
        result = api_post("gw_group_members", {
            "group_id": g['id'],
            "user_id": tsg_id,
        })
        if result:
            added += 1
    
    print(f"  {added}グループに追加 (既に{len(existing_group_ids)}グループに参加済み)")


# === Step 3: Excel投稿データを全グループに投稿 ===
def post_all_from_excel(tsg_id):
    print("\n=== Step 3: Excel投稿データを各グループに投稿 ===")
    
    # グループ名→IDマップ取得
    groups = api_get("gw_groups?select=id,name,type")
    group_map = {g['name']: g for g in groups}
    
    # Excel読み込み
    wb = openpyxl.load_workbook(EXCEL_PATH)
    ws = wb.active
    
    total_posted = 0
    
    for row in ws.iter_rows(min_row=2, max_row=ws.max_row, values_only=False):
        vals = [str(c.value) if c.value is not None else '' for c in row]
        group_name = vals[1]
        
        if group_name not in group_map:
            print(f"\n  SKIP: グループ「{group_name}」が見つかりません")
            continue
        
        group = group_map[group_name]
        group_id = group['id']
        group_type = group['type']
        
        # 投稿本文を収集（最大3件: cols 9, 13, 17 = index 9, 13, 17）
        posts = []
        for i in range(3):
            body_idx = 9 + i * 4  # 最新投稿1_本文=9, 2_本文=13, 3_本文=17
            if body_idx < len(vals) and vals[body_idx].strip():
                posts.append(vals[body_idx])
        
        if not posts:
            print(f"\n  SKIP: {group_name} - 投稿データなし")
            continue
        
        print(f"\n  {group_name} ({group_type}) -> {len(posts)}件")
        
        for post_body in reversed(posts):  # 古い順に投稿（リストは新しい順）
            if group_type == 'board':
                # 掲示板: gw_postsに投稿
                result = api_post("gw_posts", {
                    "group_id": group_id,
                    "user_id": tsg_id,
                    "content": post_body,
                })
            else:
                # チャット: gw_messagesに投稿
                result = api_post("gw_messages", {
                    "group_id": group_id,
                    "user_id": tsg_id,
                    "content": post_body,
                })
            
            if result:
                preview = post_body[:60].replace('\n', ' ')
                print(f"    OK: {preview}...")
                total_posted += 1
            else:
                preview = post_body[:60].replace('\n', ' ')
                print(f"    FAIL: {preview}...")
    
    print(f"\n=== 完了: 合計 {total_posted}件 投稿しました ===")


def main():
    # Step 1
    tsg_id = create_tsg_user()
    if not tsg_id:
        return
    
    # Step 2
    add_to_all_groups(tsg_id)
    
    # Step 3
    post_all_from_excel(tsg_id)


if __name__ == "__main__":
    main()
