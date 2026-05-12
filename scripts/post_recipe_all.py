#!/usr/bin/env python3
"""【レシピ】食のブランド館にExcel全投稿を一括登録"""
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
EXCEL_PATH = r"C:\作業用\facebook_recipe_group_all_posts_2026-05-12.xlsx"

def api_get(path):
    req = urllib.request.Request(SUPABASE_URL + "/rest/v1/" + path, headers=HEADERS)
    return json.loads(urllib.request.urlopen(req).read())

def api_post(path, data):
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(SUPABASE_URL + "/rest/v1/" + path, data=body, headers=HEADERS, method="POST")
    try:
        resp = urllib.request.urlopen(req)
        return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8")
        print("  ERROR " + str(e.code) + ": " + err[:200])
        return None

def main():
    # TSG君のID
    tsg_users = api_get("gw_users?display_name=eq." + urllib.parse.quote("TSG君") + "&select=id")
    tsg_id = tsg_users[0]["id"]
    print("TSG君 ID: " + tsg_id[:8] + "...")

    # グループ取得
    gname_enc = urllib.parse.quote("【レシピ】食のブランド館")
    groups = api_get("gw_groups?name=eq." + gname_enc + "&select=id,name,type")
    group = groups[0]
    print("Group: " + group["name"] + " (" + group["id"][:8] + "...) type=" + group["type"])

    # 既存投稿チェック
    existing = api_get("gw_posts?group_id=eq." + group["id"] + "&select=content&limit=200")
    existing_set = set()
    for p in existing:
        existing_set.add(p["content"][:50])
    print("既存投稿: " + str(len(existing)) + "件")

    # Excel読み込み
    wb = openpyxl.load_workbook(EXCEL_PATH)
    ws = wb["Recipe Group Posts"]

    posts = []
    for row in ws.iter_rows(min_row=2, max_row=ws.max_row, values_only=True):
        no, date, author, body, url, fetched = row
        if body and str(body).strip():
            posts.append({"body": str(body), "date": str(date) if date else "", "author": str(author) if author else ""})

    print("Excel投稿数: " + str(len(posts)) + "件\n")

    # 古い順に投稿（Excelは新しい順→reverse）
    posts.reverse()
    posted = 0
    skipped = 0

    for p in posts:
        key = p["body"][:50]
        if key in existing_set:
            preview = p["body"][:50].replace("\n", " ")
            print("  SKIP(既存): " + preview + "...")
            skipped += 1
            continue

        result = api_post("gw_posts", {
            "group_id": group["id"],
            "user_id": tsg_id,
            "content": p["body"],
        })

        if result:
            preview = p["body"][:60].replace("\n", " ")
            print("  OK [" + p["date"] + "] " + preview + "...")
            posted += 1
            existing_set.add(key)
        else:
            preview = p["body"][:40].replace("\n", " ")
            print("  FAIL: " + preview)

    print("\n=== 完了: 投稿" + str(posted) + "件, スキップ" + str(skipped) + "件 ===")

if __name__ == "__main__":
    main()
