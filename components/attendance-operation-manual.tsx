"use client";

const screenshots = [
  {
    src: "/manual/screenshots/time-clock-staff-list.png",
    title: "タイムレコーダー: 名前一覧",
    note: "専用端末ではスタッフ名が部署ごとにスクエアボタンで表示されます。",
  },
  {
    src: "/manual/screenshots/time-clock-confirm.png",
    title: "タイムレコーダー: 出勤/退勤確認",
    note: "名前を押すと確認画面が表示され、次に必要な打刻だけを大きく表示します。",
  },
];

export function AttendanceOperationManual() {
  return (
    <article className="manual-print-root attendance-manual">
      <div className="manual-toolbar no-print">
        <div>
          <h2>勤怠タイムレコーダー運用マニュアル</h2>
          <span>本社・道の駅 専用端末運用</span>
        </div>
        <button type="button" className="btn-primary" onClick={() => window.print()}>
          印刷
        </button>
      </div>

      <header className="manual-cover">
        <div className="manual-cover__label">TS Groupware</div>
        <h1>勤怠タイムレコーダー運用マニュアル</h1>
        <p>本社・道の駅の専用端末で、スタッフ本人が自分の名前を押して出勤・退勤を記録するための運用手順です。</p>
        <dl>
          <div><dt>対象</dt><dd>全ユーザー、役員・管理者、専用タイムレコーダー端末</dd></div>
          <div><dt>方式</dt><dd>専用端末 / PINなし / 名前選択 / 管理者修正ログあり</dd></div>
          <div><dt>更新日</dt><dd>2026年7月30日</dd></div>
        </dl>
      </header>

      <section className="manual-section">
        <h2>1. 基本方針</h2>
        <ul>
          <li>打刻は原則として、本社・道の駅に設置した専用端末で行います。</li>
          <li>スタッフは自分の名前を押し、確認画面で出勤または退勤を押します。</li>
          <li>PIN入力は行いません。誤打刻は削除せず、管理者が無効化して履歴を残します。</li>
          <li>給与計算・人事・労務データを扱えるのは役員だけです。</li>
        </ul>
      </section>

      <section className="manual-section">
        <h2>2. 専用端末の準備</h2>
        <ol>
          <li>TSGに役員または管理者でログインします。</li>
          <li>下メニューの「管理」を開きます。</li>
          <li>「勤怠」タブを開きます。</li>
          <li>本社または道の駅の「端末URL」をコピーします。</li>
          <li>設置する端末のブラウザでURLを開き、ホーム画面またはブックマークに登録します。</li>
        </ol>
        <p className="manual-note">端末URLには端末キーが含まれます。通常スタッフに共有する必要はなく、設置端末だけで使います。</p>
      </section>

      <section className="manual-section">
        <h2>3. 出勤・退勤の手順</h2>
        <ol>
          <li>専用端末でタイムレコーダー画面を開きます。</li>
          <li>自分の名前ボタンを押します。</li>
          <li>表示された名前が自分であることを確認します。</li>
          <li>出勤時は「出勤」、退勤時は「退勤」を押します。</li>
          <li>完了メッセージが表示されたら打刻完了です。数秒後に名前一覧へ戻ります。</li>
        </ol>
        <p className="manual-note">システムは直前の打刻から次に押すべきボタンを自動判定します。出勤済みの人には退勤、未出勤の人には出勤が表示されます。</p>
      </section>

      <section className="manual-section manual-screens">
        <h2>4. 画面イメージ</h2>
        <div className="manual-screenshot-grid">
          {screenshots.map((image) => (
            <figure key={image.src}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.src} alt={image.title} />
              <figcaption>
                <strong>{image.title}</strong>
                <span>{image.note}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="manual-section">
        <h2>5. 役員・管理者の確認・修正</h2>
        <ol>
          <li>TSGの「管理」を開きます。</li>
          <li>「勤怠」タブを開きます。</li>
          <li>日付を選び、当日の打刻ログを確認します。</li>
          <li>誤打刻がある場合は「無効化」を押し、理由を入力します。</li>
          <li>不足している打刻がある場合は、スタッフ・出勤/退勤・時刻・端末・メモを入力して追加します。</li>
        </ol>
        <p className="manual-note">打刻ログは監査用に残します。誤打刻は物理削除ではなく無効化で処理します。</p>
      </section>

      <section className="manual-section">
        <h2>6. 権限</h2>
        <table className="manual-table">
          <thead>
            <tr><th>機能</th><th>利用できる人</th></tr>
          </thead>
          <tbody>
            <tr><td>ユーザー管理</td><td>役員・管理者</td></tr>
            <tr><td>グループ管理</td><td>役員・管理者</td></tr>
            <tr><td>勤怠確認・打刻修正</td><td>役員・管理者</td></tr>
            <tr><td>給与計算・人事・労務</td><td>役員</td></tr>
            <tr><td>有給申請・本人の勤怠確認</td><td>対象となるユーザー本人</td></tr>
            <tr><td>忌引き休暇申請</td><td>5日正社員・6日正社員</td></tr>
            <tr><td>マニュアル閲覧</td><td>全ユーザー</td></tr>
          </tbody>
        </table>
      </section>

      <section className="manual-section">
        <h2>7. 日次運用チェック</h2>
        <ul>
          <li>朝: 専用端末がタイムレコーダー画面を表示しているか確認します。</li>
          <li>昼: 端末がスリープやログアウトで止まっていないか確認します。</li>
          <li>終業後: 役員・管理者は管理画面の勤怠タブで未退勤・不自然な打刻を確認します。</li>
          <li>月末: 役員・管理者が誤打刻を修正し、役員が給与集計に進みます。</li>
        </ul>
      </section>

      <section className="manual-section">
        <h2>8. トラブル対応</h2>
        <table className="manual-table">
          <thead>
            <tr><th>状況</th><th>対応</th></tr>
          </thead>
          <tbody>
            <tr><td>名前が表示されない</td><td>管理のユーザーで承認済みになっているか確認します。</td></tr>
            <tr><td>間違えて他人の名前で押した</td><td>管理者が該当打刻を無効化し、正しい打刻を手動追加します。</td></tr>
            <tr><td>端末が動かない</td><td>ブラウザ更新、端末再起動、別端末で端末URLを開く順に確認します。</td></tr>
            <tr><td>退勤ではなく出勤が出る</td><td>前回の出勤打刻が無効化されている、または打刻漏れの可能性があります。管理画面でログを確認します。</td></tr>
          </tbody>
        </table>
      </section>
    </article>
  );
}
