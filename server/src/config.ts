import { z } from 'zod';

const schema = z.object({
  /** production이면 공개된 개발용 비밀값을 거부하고, 계좌 개설 인증 코드(devCode)를 응답에 싣지 않는다 */
  NODE_ENV: z.string().optional(),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** 모의 주문 발생기(종목마다 이 주기로 주문을 넣는다). 0이면 끔 */
  SIM_INTERVAL_MS: z.coerce.number().int().min(0).default(100),
  /** 시작할 때 채울 과거 1분 봉 수(모의 데이터) */
  HISTORY_MINUTES: z.coerce.number().int().min(0).max(2_000).default(240),

  // ---- 장애 주입 (앱의 복구 동작을 시연하기 위한 옵션) ----
  /** 이 확률로 시세 변경분을 일부러 빠뜨린다(seq는 증가) → 클라이언트 재동기화 유도 */
  FAULT_DROP_SEQ_RATE: z.coerce.number().min(0).max(1).default(0),
  /** 주문을 처리한 뒤 응답만 이만큼 늦춘다 → 클라이언트 타임아웃 후 조회 흐름 유도 */
  FAULT_ORDER_DELAY_MS: z.coerce.number().int().min(0).default(0),

  // ---- 게이트웨이 보호 장치 ----
  WS_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(15_000),
  WS_MAX_PAYLOAD_BYTES: z.coerce.number().int().min(256).default(4 * 1024),
  /** 관심종목은 화면에 보이는 종목만 구독한다(약 15개 + 호가 화면) */
  WS_MAX_SUBSCRIPTIONS: z.coerce.number().int().min(1).default(40),
  WS_MSG_RATE_PER_SEC: z.coerce.number().min(1).default(20),
  /** 이만큼 쌓이면 변경분 대신 나중에 최신 스냅샷 1개로 합쳐 보낸다 */
  WS_SOFT_BUFFER_BYTES: z.coerce.number().int().min(1024).default(512 * 1024),
  /** 이만큼 쌓이면 연결을 끊는다(1013 Try Again Later) */
  WS_HARD_BUFFER_BYTES: z.coerce.number().int().min(1024).default(1024 * 1024),
  /**
   * 한꺼번에 끊을 때(1012) 초당 받아들일 재접속 수. 재접속 창 = 연결 수 ÷ 이 값(0.5~30초).
   * 기본 300은 맥북(M4) 한 대에서 5,000명·초당 약 10만 메시지를 보내면서 accept 대기열(128)이 넘치지 않은 값(k6 측정).
   * 1,000이면 재접속의 14%가 연결 시간 초과로 실패했다.
   */
  WS_RECONNECT_ACCEPT_PER_SEC: z.coerce.number().int().min(10).default(300),

  /** 멱등 키 보관 시간 */
  IDEMPOTENCY_TTL_MS: z.coerce.number().int().min(1000).default(24 * 60 * 60 * 1000),
  // ---- 인증 ----
  /** HS256 서명 키. 운영에서는 반드시 32바이트 이상 무작위 값으로 바꾼다 */
  JWT_SECRET: z.string().min(16).default('hoga-dev-only-secret-change-me'),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(10).default(15 * 60),
  REFRESH_TOKEN_TTL_SEC: z.coerce.number().int().min(60).default(7 * 24 * 60 * 60),
  LOGIN_MAX_FAILURES_PER_MIN: z.coerce.number().int().min(1).default(5),
  /** OTP 시드 암호화 키(AES-256-GCM, 이 값의 SHA-256). 운영에서는 KMS 등에서 받은 무작위 값으로 */
  OTP_ENC_KEY: z.string().min(16).default('hoga-dev-only-otp-key-change-me'),

  // ---- 웹 화면 · 관리 콘솔 ----
  /** 관리 콘솔 API 토큰(x-admin-token). 운영에서는 반드시 바꾸고, 관리 경로는 내부망에서만 연다 */
  ADMIN_TOKEN: z.string().min(12).default('hoga-admin-dev-token'),
  /** 웹 화면에 심을 GTM 컨테이너 ID(예: GTM-ABC1234). 없으면 GTM을 불러오지 않고 dataLayer에만 쌓는다 */
  GTM_CONTAINER_ID: z
    .string()
    .regex(/^GTM-[A-Z0-9]{4,12}$/)
    .optional(),

  // ---- 여러 프로세스(M7) ----
  /** manual: 관리 콘솔로 장 구간을 바꾼다(기본 장중) · krx: 서울 시각 정규장 일정 */
  SESSION_CLOCK: z.enum(['manual', 'krx']).default('manual'),
  /** VI 단일가 시간(KRX 2분) */
  VI_DURATION_MS: z.coerce.number().int().min(1_000).default(120_000),
  VI_STATIC_BPS: z.coerce.number().int().min(1).default(1_000),
  VI_DYNAMIC_BPS: z.coerce.number().int().min(1).default(300),
  /**
   * all: 한 프로세스에 전부(개발 기본) · market: 시세 단일 작성자 + REST(주문·인증·관리)
   * gateway: WebSocket 팬아웃만(여러 대). market·gateway는 REDIS_URL이 필요하다
   */
  ROLE: z.enum(['all', 'market', 'gateway']).default('all'),
  /** 있으면 버스·멱등 키·리프레시 토큰을 Redis에 둔다(ROLE=all에서도) */
  REDIS_URL: z.string().optional(),
  /** gateway가 복제 장부의 스냅샷을 받을 market 주소 */
  MARKET_URL: z.string().default('http://127.0.0.1:8200'),
  /** gateway 이름(관리 콘솔 표시용). 기본: gw-<포트> */
  GATEWAY_ID: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

/** 저장소에 공개된 개발용 기본값. 운영(NODE_ENV=production)에서는 쓰지 못하게 한다 */
const DEV_SECRETS = ['JWT_SECRET', 'OTP_ENC_KEY', 'ADMIN_TOKEN'] as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const config = schema.parse(env);
  if (config.NODE_ENV === 'production') {
    const defaults = schema.parse({});
    const unset = DEV_SECRETS.filter((key) => config[key] === defaults[key]);
    // 공개 저장소의 기본값이면 누구나 JWT를 위조하고 관리 API를 쓸 수 있다
    if (unset.length > 0) throw new Error(`NODE_ENV=production requires ${unset.join(', ')} (dev defaults are public)`);
  }
  if (config.ROLE !== 'all' && !config.REDIS_URL) throw new Error(`ROLE=${config.ROLE} requires REDIS_URL`);
  return config;
}
