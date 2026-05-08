import Head from 'next/head'
import Link from 'next/link'

const EFFECTIVE_DATE = '2026-05-08'

export default function Privacy() {
  return (
    <>
      <Head>
        <title>개인정보처리방침 · ClassBridge</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="min-h-screen bg-[#0a0a0a] text-white">
        <div className="max-w-2xl mx-auto px-6 py-12">

          <Link href="/" className="text-white/60 hover:text-white text-sm mb-8 inline-block">← 돌아가기</Link>

          <h1 className="text-3xl font-bold tracking-tight mb-2">개인정보처리방침</h1>
          <p className="text-white/50 text-sm mb-10">시행일: {EFFECTIVE_DATE} (베타)</p>

          <div className="space-y-8 text-white/80 text-base leading-relaxed">

            <section>
              <p>
                ClassBridge(이하 &lsquo;서비스&rsquo;)는 개인정보 보호법 등 관련 법령을 준수하며,
                다음과 같이 개인정보를 처리합니다. 본 서비스는 익명 사용을 전제로 설계되어 있어 수집하는
                정보가 매우 제한적입니다.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-3">1. 수집하는 항목</h2>
              <p className="mb-3">서비스 운영을 위해 다음 정보를 수집합니다.</p>
              <ul className="space-y-2 list-disc list-inside text-white/70">
                <li>
                  <span className="text-white">접속 IP 주소, 브라우저/OS 정보(User-Agent)</span> — 보안 및
                  악용 방지 목적의 일시적 처리. 식별자로 저장하지 않습니다.
                </li>
                <li>
                  <span className="text-white">학생 디바이스 익명 식별자</span> — 학생 브라우저의
                  로컬 저장소(localStorage)에 무작위 UUID가 저장되며, 같은 학생이 여러 디바이스/탭에서
                  접속하더라도 한 명으로 정확하게 카운트하기 위한 목적으로만 사용됩니다.
                  서버는 이 식별자로부터 이름·이메일·학번 등 다른 정보를 알 수 없습니다.
                  학생이 브라우저 데이터를 삭제하면 새 식별자가 발급됩니다.
                </li>
                <li>
                  <span className="text-white">학생의 현재 상태(이해 완료 / 속도 조절 / 재설명)</span> —
                  학생이 마지막으로 선택한 상태만 저장되며, 누적 횟수는 저장하지 않습니다.
                  강의 종료 또는 학생 페이지 이탈 시 상태는 사라집니다.
                </li>
                <li>
                  <span className="text-white">익명 질문 본문</span> — 작성자 식별 정보 없이
                  강의 회차에 저장됩니다.
                </li>
                <li>
                  <span className="text-white">강의 회차의 시계열 통계</span> — 약 15초 간격으로 학생 수와
                  상태 분포의 스냅샷이 누적되어 그래프로 시각화됩니다. 개별 학생 정보는 포함되지 않습니다.
                </li>
                <li>
                  <span className="text-white">교수자가 입력한 강의 이름</span> — 강의 식별 목적.
                </li>
                <li>
                  <span className="text-white">강의 코드 및 교수자 토큰</span> — 서비스 운영에 필요한 식별자.
                </li>
              </ul>
              <p className="mt-3 text-white/70">
                <span className="text-white">수집하지 않는 정보</span>: 이름, 이메일, 전화번호, 학번, 위치 정보,
                광고 식별자, 기기 고유 식별자 등 직접 식별 가능한 정보를 수집하지 않습니다.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-3">2. 처리 목적</h2>
              <ul className="space-y-2 list-disc list-inside text-white/70">
                <li>실시간 수업 피드백(리액션·익명 질문)의 송수신</li>
                <li>강의 회차 데이터 누적 및 통계 제공(교수자 한정)</li>
                <li>서비스 안정 운영, 어뷰징·DDoS 방지, 디버깅</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-3">3. 보관 기간</h2>
              <ul className="space-y-2 list-disc list-inside text-white/70">
                <li>접속 IP/User-Agent: 휘발성 처리(서버 메모리 한정), 별도 저장하지 않음</li>
                <li>학생의 현재 상태: 강의 진행 중에만 유지. 강의 종료 또는 페이지 이탈 시 즉시 폐기</li>
                <li>학생 디바이스 익명 식별자: 학생의 브라우저 로컬에만 저장(서버 영구 저장 X). 학생이 브라우저 데이터를 삭제하면 즉시 사라짐</li>
                <li>익명 질문 · 회차 시계열 통계: 강의 생성일로부터 최대 1년</li>
                <li>강의 자체(코드, 이름): 최대 1년 후 자동 삭제</li>
                <li>교수자는 개별 회차 또는 강의 전체를 직접 삭제할 수 있으며, 삭제 시 해당 데이터는 즉시 제거됨</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-3">4. 제3자 제공</h2>
              <p className="text-white/70">
                서비스는 수집한 정보를 외부에 제공하지 않습니다. 다만 서비스 운영을 위해 다음 처리위탁이
                발생합니다.
              </p>
              <ul className="space-y-2 list-disc list-inside text-white/70 mt-3">
                <li>
                  <span className="text-white">Fly.io</span>(서버 호스팅, 일본 도쿄 리전) — 서비스 데이터 저장 및 전송.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-3">5. 이용자의 권리</h2>
              <p className="text-white/70 mb-3">
                이용자는 언제든 본인이 제공한 정보의 열람, 정정, 삭제, 처리정지를 요구할 수 있습니다.
                다만 본 서비스는 익명으로 운영되어 개별 이용자(학생)의 정보를 식별·분리할 수 없습니다.
                특정 강의 데이터의 삭제를 원하시는 경우 해당 강의의 교수자에게 요청해 주시기 바랍니다.
              </p>
              <p className="text-white/70">
                학생 디바이스 식별자는 본인의 브라우저 설정(저장된 데이터 / 사이트 데이터 삭제)에서
                직접 제거하실 수 있으며, 제거 시 다음 접속부터 새로운 식별자가 발급됩니다.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-3">6. 보안 조치</h2>
              <ul className="space-y-2 list-disc list-inside text-white/70">
                <li>모든 통신은 HTTPS/WSS로 암호화됩니다.</li>
                <li>교수자 권한은 강의별 독립 토큰으로 분리됩니다.</li>
                <li>학생 IP/UA는 서버에 영구 저장되지 않습니다.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-3">7. 변경 안내</h2>
              <p className="text-white/70">
                본 방침은 서비스 정책 또는 관련 법령 변경에 따라 갱신될 수 있으며,
                변경 시 본 페이지에 공지합니다.
              </p>
            </section>

            <section className="pt-4 border-t border-white/10">
              <p className="text-white/50 text-sm">
                본 서비스는 현재 베타 운영 중입니다. 문의·신고는 베타 안내 채널을 통해 받습니다.
              </p>
            </section>

          </div>
        </div>
      </div>
    </>
  )
}
