"use client";

const screenshots = [
  {
    src: "/manual/screenshots/paid-leave-home-mobile.png",
    title: "希望回収のお知らせ",
    note: "希望回収中はホーム上部に対象期間と提出期限が表示されます。",
  },
  {
    src: "/manual/screenshots/paid-leave-request-mobile.png",
    title: "有給希望の入力",
    note: "全休または半休を選び、取得したい日を押して保存します。",
  },
];

export function PaidLeaveOperationManual() {
  return (
    <article className="manual-print-root attendance-manual paid-leave-manual">
      <div className="manual-toolbar no-print">
        <div>
          <h2>有給取得マニュアル</h2>
          <span>希望回収・個別申請・残日数確認</span>
        </div>
        <button type="button" className="btn-primary" onClick={() => window.print()}>
          印刷
        </button>
      </div>

      <header className="manual-cover">
        <div className="manual-cover__label">TS Groupware</div>
        <h1>有給取得マニュアル</h1>
        <p>
          予定している有給はシフト希望と一緒に提出します。希望回収後や急な申請は、
          管理メニューの有給申請から所属管理者へ申請します。
        </p>
        <dl>
          <div><dt>対象</dt><dd>有給管理対象の全ユーザー</dd></div>
          <div><dt>区分</dt><dd>有給（全休）1日 / 有給（半休）0.5日</dd></div>
          <div><dt>運用開始</dt><dd>2026年8月1日</dd></div>
          <div><dt>更新日</dt><dd>2026年7月30日</dd></div>
        </dl>
      </header>

      <section className="manual-section">
        <h2>1. 申請方法を選ぶ</h2>
        <table className="manual-table">
          <thead>
            <tr><th>状況</th><th>申請する場所</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>次回シフトの有給を予定している</td>
              <td>ホーム上部の希望回収、または上部のシフトボタンから「希望提出」</td>
            </tr>
            <tr>
              <td>希望回収の締切後・シフト確定前</td>
              <td>同じ「希望提出」画面（有給のみ変更可能）</td>
            </tr>
            <tr>
              <td>シフト確定後・急な有給</td>
              <td>下メニュー「管理」→「有給申請」</td>
            </tr>
            <tr>
              <td>残日数・付与日・履歴を確認する</td>
              <td>下メニュー「管理」→「有給申請」→「有給申請を開く」</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="manual-section">
        <h2>2. シフト希望と一緒に申請する</h2>
        <ol>
          <li>希望回収中に、ホーム上部の「シフト希望回収」を押します。</li>
          <li>上部の「希望提出」を開き、対象期間を確認します。</li>
          <li>「有給（全休）」または「有給（半休）」を選びます。</li>
          <li>有給を取りたい日を押します。</li>
          <li>「保存して提出」を押します。</li>
        </ol>
        <p className="manual-note">
          提出期限を過ぎても、シフト確定前は同じ画面から有給（全休・半休）だけ変更できます。
          通常の希望休や勤務条件は変更できません。
        </p>
      </section>

      <section className="manual-section manual-screens">
        <h2>3. 希望回収の画面</h2>
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
        <h2>4. シフト確定後・急な有給を申請する</h2>
        <ol>
          <li>下メニューの「管理」を開きます。</li>
          <li>「有給申請」タブを開き、「有給申請を開く」を押します。</li>
          <li>取得日と「有給（全休）」または「有給（半休）」を選びます。</li>
          <li>必要に応じて理由・補足を入力し、「申請する」を押します。</li>
          <li>一般スタッフは所属管理者、管理者本人は佐藤正彦が承認すると、申請履歴に「承認済み」と表示されます。</li>
        </ol>
        <p className="manual-note">
          この申請は送信しただけでは確定しません。管理者の承認後に有給として確定し、
          残日数へ反映されます。
        </p>
      </section>

      <section className="manual-section">
        <h2>5. 残日数と履歴を確認する</h2>
        <ul>
          <li>「有給・欠勤」画面で、現在の有給残日数を確認できます。</li>
          <li>次回付与日と次回付与予定日数を確認できます。</li>
          <li>申請履歴では、申請中・承認済み・却下の状態を確認できます。</li>
          <li>出勤率は2026年8月1日から計測し、集計期間がそろうまでは「計測中」と表示します。</li>
        </ul>
      </section>

      <section className="manual-section">
        <h2>6. 半休・打刻・急な欠勤</h2>
        <ul>
          <li>有給（全休）は1日、有給（半休）は0.5日として残日数から差し引きます。</li>
          <li>半休の日に勤務した時間は、専用タイムレコーダーで通常どおり出勤・退勤を打刻します。</li>
          <li>確定シフトの勤務日に打刻がない場合、TSGから理由確認が表示されます。</li>
          <li>5日正社員・6日正社員は理由確認で「忌引き休」を選択できます。管理者確定後も有給残日数と欠勤回数には影響しません。</li>
          <li>緊急の欠勤は、TSGへの入力だけで済ませず、これまでどおり所属管理者へ直接連絡してください。</li>
        </ul>
      </section>

      <section className="manual-section">
        <h2>7. 注意事項</h2>
        <ul>
          <li>口頭・電話・DMで連絡しただけでは、TSG上の有給申請は完了しません。</li>
          <li>申請前に、画面に表示される有給残日数を確認してください。</li>
          <li>申請内容の変更や取消しが必要な場合は、承認前後を問わず所属管理者へ連絡してください。</li>
          <li>残日数、入社日、勤務形態の表示に疑問がある場合は所属管理者へ確認してください。</li>
        </ul>
      </section>

      <section className="manual-section">
        <h2>8. 正社員の忌引き休暇</h2>
        <p>
          5日正社員・6日正社員は、下メニュー「管理」→「休暇申請」→「忌引き休暇」から申請します。
          有給休暇の残日数は消費しません。
        </p>
        <table className="manual-table">
          <thead>
            <tr><th>親等</th><th>主な親族</th><th>規定日数</th></tr>
          </thead>
          <tbody>
            <tr><td>1親等</td><td>父母・子</td><td>7日</td></tr>
            <tr><td>2親等</td><td>祖父母・孫・兄弟姉妹</td><td>3日</td></tr>
            <tr><td>3親等</td><td>曽祖父母・ひ孫・叔父叔母・甥姪</td><td>1日</td></tr>
            <tr><td>4親等</td><td>いとこ</td><td>規定なし</td></tr>
          </tbody>
        </table>
        <ol>
          <li>亡くなられた方との続柄を選択します。</li>
          <li>取得開始日と勤務日数を選びます。確定シフト上の元々の休みは除外され、実際に忌引きとなる勤務日が画面に表示されます。</li>
          <li>「申請する」を押します。所属管理者の承認後に確定します。</li>
        </ol>
      </section>
    </article>
  );
}
