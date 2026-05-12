#!/usr/bin/env python3
"""Facebook Groups → TSG gw_groups 一括登録スクリプト"""
import sys, json, urllib.request, uuid
sys.stdout.reconfigure(encoding='utf-8')

SUPABASE_URL = "https://zfhswguzqyagmhhlpksq.supabase.co"
SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmaHN3Z3V6cXlhZ21oaGxwa3NxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Mjc3MjY3MiwiZXhwIjoyMDg4MzQ4NjcyfQ.actrbqYaVALBa12b3XLe_0gAbodKLd_ANukBs_GWYtk"

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

# --- Step 1: 既存グループ確認 ---
def get_existing_groups():
    url = f"{SUPABASE_URL}/rest/v1/gw_groups?select=id,name,type,icon,description&order=created_at.asc"
    req = urllib.request.Request(url, headers=HEADERS)
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())

# --- Step 2: 管理者ユーザーID取得 ---
def get_admin_user():
    url = f"{SUPABASE_URL}/rest/v1/gw_users?role=eq.admin&limit=1&select=id,display_name"
    req = urllib.request.Request(url, headers=HEADERS)
    resp = urllib.request.urlopen(req)
    users = json.loads(resp.read())
    if users:
        return users[0]
    return None

# --- Facebook groups from Excel ---
FB_GROUPS = [
    {"category": "管理中", "name": "TS(月別合計売上・製造数）", "url": "https://www.facebook.com/groups/628904948742970/"},
    {"category": "管理中", "name": "デザイン・印刷発注指示", "url": "https://www.facebook.com/groups/1151584649001973/"},
    {"category": "管理中", "name": "NEWブランド館（フロア）", "url": "https://www.facebook.com/groups/2833645026907236/"},
    {"category": "管理中", "name": "NEWブランド館（物販・製造）", "url": "https://www.facebook.com/groups/1070340976775797/"},
    {"category": "管理中", "name": "TS（管理職）", "url": "https://www.facebook.com/groups/462651737188596/"},
    {"category": "管理中", "name": "TS（製造報告）", "url": "https://www.facebook.com/groups/212962538905965/"},
    {"category": "管理中", "name": "TS（発注）", "url": "https://www.facebook.com/groups/740411789363247/"},
    {"category": "管理中", "name": "staff道の駅会津食のブランド館", "url": "https://www.facebook.com/groups/482368561834129/"},
    {"category": "管理中", "name": "TS(売上・新規・HAPPY！）", "url": "https://www.facebook.com/groups/348854951924582/"},
    {"category": "管理中", "name": "【レシピ】食のブランド館", "url": "https://www.facebook.com/groups/367910430255985/"},
    {"category": "管理中", "name": "TS（有給管理）", "url": "https://www.facebook.com/groups/1395427751260245/"},
    {"category": "参加中", "name": "TS（OEM発注）", "url": "https://www.facebook.com/groups/1462838114567344/"},
    {"category": "参加中", "name": "道の駅ひらた商品開発", "url": "https://www.facebook.com/groups/652432048219781/"},
    {"category": "参加中", "name": "TS（経理）会計書類は月末までに必ず会計事務所へ", "url": "https://www.facebook.com/groups/728302260558079/"},
    {"category": "参加中", "name": "TS（総務）", "url": "https://www.facebook.com/groups/386776268063721/"},
]

# アイコン自動割り当て
ICON_MAP = {
    "売上": "📊",
    "製造": "🏭",
    "デザイン": "🎨",
    "印刷": "🎨",
    "フロア": "🏬",
    "物販": "🛍️",
    "管理職": "👔",
    "発注": "📦",
    "staff": "👥",
    "道の駅": "🏪",
    "HAPPY": "🎉",
    "レシピ": "📝",
    "有給": "📅",
    "OEM": "🔧",
    "経理": "💰",
    "総務": "📋",
    "商品開発": "💡",
}

def get_icon(name):
    for keyword, icon in ICON_MAP.items():
        if keyword in name:
            return icon
    return "📢"

def insert_group(group_data):
    url = f"{SUPABASE_URL}/rest/v1/gw_groups"
    body = json.dumps(group_data).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=HEADERS, method="POST")
    try:
        resp = urllib.request.urlopen(req)
        result = json.loads(resp.read())
        return result[0] if result else None
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8")
        print(f"  ERROR: {e.code} - {err_body}")
        return None

def main():
    print("=== TSG グループ一括登録 ===\n")

    # 既存グループ確認
    existing = get_existing_groups()
    print(f"既存グループ数: {len(existing)}")
    existing_names = set(g["name"] for g in existing)
    for g in existing:
        t = g["type"]
        icon = g["icon"] or ""
        print(f"  [{t}] {icon} {g['name']}")

    # 管理者取得
    admin = get_admin_user()
    if not admin:
        print("\nERROR: 管理者ユーザーが見つかりません")
        return
    print(f"\n管理者: {admin['display_name']} ({admin['id'][:8]}...)")

    # 新規登録
    print(f"\n--- Facebookグループ {len(FB_GROUPS)}件 を登録 ---\n")
    added = 0
    skipped = 0
    for fb in FB_GROUPS:
        name = fb["name"]
        if name in existing_names:
            print(f"  SKIP (既存): {name}")
            skipped += 1
            continue

        icon = get_icon(name)
        desc = f"Facebook: {fb['url']}"
        group_data = {
            "name": name,
            "description": desc,
            "type": "board",
            "icon": icon,
            "created_by": admin["id"],
        }
        result = insert_group(group_data)
        if result:
            print(f"  OK: {icon} {name} (id: {result['id'][:8]}...)")
            added += 1
        else:
            print(f"  FAIL: {name}")

    print(f"\n=== 完了: 追加 {added}件, スキップ {skipped}件 ===")

if __name__ == "__main__":
    main()
