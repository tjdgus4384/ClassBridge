import { Html, Head, Main, NextScript } from 'next/document'

export default function Document() {
  return (
    <Html lang="ko">
      <Head>
        {/* Favicon — 모던 브라우저는 SVG, 폴백은 PNG */}
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png" />
        <link rel="icon" href="/favicon-16.png" sizes="16x16" type="image/png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />

        {/* PWA */}
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#0a0a0a" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="ClassBridge" />

        {/* SEO / 링크 미리보기 */}
        <meta name="description" content="실시간 익명 수업 소통 도구. 학생이 QR로 접속해 수업 온도와 익명 질문을 보냅니다." />
        <meta property="og:type" content="website" />
        <meta property="og:title" content="ClassBridge" />
        <meta property="og:description" content="실시간 익명 수업 소통 도구" />
        <meta property="og:image" content="/og-image.png" />
        <meta property="og:locale" content="ko_KR" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="ClassBridge" />
        <meta name="twitter:description" content="실시간 익명 수업 소통 도구" />
        <meta name="twitter:image" content="/og-image.png" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}
