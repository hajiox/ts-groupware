const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://v0-line-blush.vercel.app";
const lineLoginUrl = `${siteUrl}/api/auth/line`;
const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=12&data=${encodeURIComponent(lineLoginUrl)}`;

/**
 * TOPページ
 *
 * PC画面に表示したQRをスマホで読み取り、LINEログインへ進める入口。
 */
export default function RootPage() {
  return (
    <main className="top-page" role="main">
      <section className="top-panel" aria-label="TS Groupware ログイン">
        <div className="login-logo top-logo">
          <div className="login-logo__icon" aria-hidden="true">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
              <rect width="40" height="40" rx="10" fill="#3b82f6" fillOpacity="0.15" />
              <path
                d="M8 20c0-6.627 5.373-12 12-12s12 5.373 12 12-5.373 12-12 12S8 26.627 8 20z"
                fill="none"
                stroke="#60a5fa"
                strokeWidth="1.5"
              />
              <path d="M14 20h12M20 14v12" stroke="#93c5fd" strokeWidth="2" strokeLinecap="round" />
              <circle cx="20" cy="20" r="3" fill="#3b82f6" />
            </svg>
          </div>
          <h1 className="login-logo__name">TS Groupware</h1>
          <p className="login-logo__sub">社内グループウェア</p>
        </div>

        <div className="top-qr">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrUrl} alt="LINEログインへ進むQRコード" width={220} height={220} />
        </div>

        <a href={lineLoginUrl} className="btn-line top-login-btn" aria-label="LINEアカウントでログイン">
          <span className="btn-line__icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="white" aria-hidden="true">
              <path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63h2.386c.349 0 .63.285.63.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63.349 0 .631.285.631.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.281.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314" />
            </svg>
          </span>
          LINEでログイン
        </a>
      </section>
    </main>
  );
}
