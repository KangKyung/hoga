import { z } from 'zod';

const schema = z.object({
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
  WS_MAX_SUBSCRIPTIONS: z.coerce.number().int().min(1).default(20),
  WS_MSG_RATE_PER_SEC: z.coerce.number().min(1).default(20),
  /** 이만큼 쌓이면 변경분 대신 나중에 최신 스냅샷 1개로 합쳐 보낸다 */
  WS_SOFT_BUFFER_BYTES: z.coerce.number().int().min(1024).default(512 * 1024),
  /** 이만큼 쌓이면 연결을 끊는다(1013 Try Again Later) */
  WS_HARD_BUFFER_BYTES: z.coerce.number().int().min(1024).default(1024 * 1024),

  /** 멱등 키 보관 시간 */
  IDEMPOTENCY_TTL_MS: z.coerce.number().int().min(1000).default(24 * 60 * 60 * 1000),
  // ---- 인증 ----
  /** HS256 서명 키. 운영에서는 반드시 32바이트 이상 무작위 값으로 바꾼다 */
  JWT_SECRET: z.string().min(16).default('hoga-dev-only-secret-change-me'),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(10).default(15 * 60),
  REFRESH_TOKEN_TTL_SEC: z.coerce.number().int().min(60).default(7 * 24 * 60 * 60),
  LOGIN_MAX_FAILURES_PER_MIN: z.coerce.number().int().min(1).default(5),

  // ---- 웹 화면 · 관리 콘솔 ----
  /** 관리 콘솔 API 토큰(x-admin-token). 운영에서는 반드시 바꾸고, 관리 경로는 내부망에서만 연다 */
  ADMIN_TOKEN: z.string().min(12).default('hoga-admin-dev-token'),
  /** 웹 화면에 심을 GTM 컨테이너 ID(예: GTM-ABC1234). 없으면 GTM을 불러오지 않고 dataLayer에만 쌓는다 */
  GTM_CONTAINER_ID: z
    .string()
    .regex(/^GTM-[A-Z0-9]{4,12}$/)
    .optional(),

  /** 사용 예정: Redis 연결(M6). 지금은 메모리 구현만 사용 */
  REDIS_URL: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return schema.parse(env);
}
