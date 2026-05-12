#!/usr/bin/env python3
"""【レシピ】食のブランド館の既存投稿を全削除→全文版Excelで再投稿"""
import sys, json, urllib.request, urllib.parse, openpyxl
sys.stdout.reconfigure(encoding='utf-8')

SUPABASE_URL = "https://zfhswguzqyagmhhlpksq.supabase.co"
SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmaHN3Z3V6cXlhZ21oaGxwa3NxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Mjc3MjY3MiwiZXhwIjoyMDg4MzQ4NjcyfQ.actrbqYaVALBa12b3XLe_0gAbodKLd_ANukBs_GWYtk"
HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": "Bearer " + SERVICE_KEY,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}
EXCEL_PATH = r"C:\作業用\facebook_recipe_group_all_posts_fulltext_2026-05-12.xlsx"

def api_get(path):
    req = urllib.request.Request(SUPABASE_URL + "/rest/v1/" + path, headers=HEADERS)
    return json.loads(urllib.request.urlopen(req).read())

def api_post(path, data):
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(SUPABASE_URL + "/rest/v1/" + path, data=body, headers=HEADERS, method="POST")
    try:
        return json.loads(urllib.request.urlopen(req).read())
    except urllib.error.HTTPError as e:
        print("  ERROR " + str(e.code) + ": " + e.read().decode("utf-8")[:200])
        return None

def api_delete(path):
    req = urllib.request.Request(SUPABASE_URL + "/rest/v1/" + path, headers=HEADERS, method="DELETE")
    try:
        urllib.request.urlopen(req)
        return True
    except urllib.error.HTTPError as e:
        print("  DELETE ERROR: " + e.read().decode("utf-8")[:200])
        return False

def main():
    # TSG君ID
    tsg_users = api_get("gw_users?display_name=eq." + urllib.parse.quote("TSG君") + "&select=id")
    tsg_id = tsg_users[0]["id"]
    print("TSG君: " + tsg_id[:8] + "...")

    # グループ取得
    gname_enc = urllib.parse.quote("【レシピ】食のブランド館")
    groups = api_get("gw_groups?name=eq." + gname_enc + "&select=id,name")
    group_id = groups[0]["id"]
    print("Group: " + groups[0]["name"] + " (" + group_id[:8] + "...)")

    # Step 1: 既存投稿を全削除
    print("\n--- Step 1: 既存投稿を全削除 ---")
    existing = api_get("gw_posts?group_id=eq." + group_id + "&select=id,content&limit=200")
    print("既存投稿: " + str(len(existing)) + "件")
    
    # 既存のリアクション・コメントも削除
    for p in existing:
        api_delete("gw_reactions?post_id=eq." + p["id"])
        api_delete("gw_comments?post_id=eq." + p["id"])
    
    if existing:
        api_delete("gw_posts?group_id=eq." + group_id)
        print("  全件削除完了")

    # Step 2: 全文版Excelから再投稿
    print("\n--- Step 2: 全文版Excelから投稿 ---")
    wb = openpyxl.load_workbook(EXCEL_PATH)
    ws = wb["Recipe Full Text"]

    posts = []
    for row in ws.iter_rows(min_row=2, max_row=ws.max_row, values_only=True):
        no, date, author, body, char_count, url, fetched = row
        if body and str(body).strip():
            posts.append({"body": str(body), "date": str(date) if date else "", "no": no})

    print("Excel全文投稿数: " + str(len(posts)) + "件\n")

    # 古い順（リストは新しい順→reverse）
    posts.reverse()
    posted = 0

    for p in posts:
        result = api_post("gw_posts", {
            "group_id": group_id,
            "user_id": tsg_id,
            "content": p["body"],
        })
        if result:
            preview = p["body"][:60].replace("\n", " ")
            print("  OK [" + p["date"] + "] " + preview + "...")
            posted += 1
        else:
            print("  FAIL: No." + str(p["no"]))

    print("\n=== 完了: " + str(posted) + "件 投稿しました ===")

if __name__ == "__main__":
    main()
