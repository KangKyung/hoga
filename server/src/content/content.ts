/**
 * 웹 화면용 모의 콘텐츠(기업 개요 · 공지). 실제 회사·서비스와 무관하다.
 * 언어별 문구가 없으면 ko로 대신한다.
 */
export const LANGS = ['ko', 'en', 'id', 'th'] as const;
export type Lang = (typeof LANGS)[number];

export const isLang = (value: unknown): value is Lang => LANGS.includes(value as Lang);

type Localized = Partial<Record<Lang, string>> & { ko: string };

export const pick = (text: Localized, lang: Lang): string => text[lang] ?? text.ko;

export const PROFILES: Record<string, Localized> = {
  '000001': {
    ko: '메모리 반도체와 스마트폰 부품을 만드는 가상의 회사입니다.',
    en: 'A fictional maker of memory chips and smartphone parts.',
    id: 'Perusahaan fiktif pembuat chip memori dan komponen ponsel.',
    th: 'บริษัทสมมติที่ผลิตชิปหน่วยความจำและชิ้นส่วนสมาร์ตโฟน',
  },
  '000002': {
    ko: '바이오시밀러를 개발하는 가상의 제약 회사입니다.',
    en: 'A fictional pharma company developing biosimilars.',
    id: 'Perusahaan farmasi fiktif yang mengembangkan biosimilar.',
    th: 'บริษัทยาสมมติที่พัฒนายาชีววัตถุคล้ายคลึง',
  },
  '000003': {
    ko: '배터리 소재를 만드는 가상의 화학 회사입니다.',
    en: 'A fictional chemicals company making battery materials.',
    id: 'Perusahaan kimia fiktif pembuat bahan baterai.',
    th: 'บริษัทเคมีสมมติที่ผลิตวัสดุแบตเตอรี่',
  },
  '000004': {
    ko: '은행·증권 자회사를 둔 가상의 금융지주입니다.',
    en: 'A fictional financial holding company with bank and brokerage units.',
    id: 'Perusahaan induk keuangan fiktif dengan unit bank dan sekuritas.',
    th: 'บริษัทโฮลดิ้งการเงินสมมติที่มีธนาคารและบริษัทหลักทรัพย์ในเครือ',
  },
  '000005': {
    ko: '모바일 게임을 만드는 가상의 게임사입니다.',
    en: 'A fictional mobile game studio.',
    id: 'Studio gim seluler fiktif.',
    th: 'สตูดิโอเกมมือถือสมมติ',
  },
};

export type NoticeCategory = 'service' | 'maintenance' | 'event';

export interface Notice {
  id: string;
  category: NoticeCategory;
  date: string;
  pinned: boolean;
  title: Localized;
  body: Localized;
}

export const NOTICES: readonly Notice[] = [
  {
    id: 'n-104',
    category: 'maintenance',
    date: '2026-11-20',
    pinned: true,
    title: {
      ko: '11월 22일(일) 새벽 시스템 점검 안내',
      en: 'Scheduled maintenance on Sun, Nov 22 (early morning)',
      id: 'Pemeliharaan sistem Minggu, 22 Nov (dini hari)',
      th: 'แจ้งปิดปรับปรุงระบบ วันอาทิตย์ที่ 22 พ.ย. (ช่วงเช้ามืด)',
    },
    body: {
      ko: '02:00~06:00 동안 로그인과 주문 조회가 잠시 중단됩니다. 시세 화면은 점검 중에도 볼 수 있습니다.',
      en: 'Sign-in and order lookup pause from 02:00 to 06:00. Quotes stay available during maintenance.',
      id: 'Masuk dan cek order berhenti sementara pukul 02.00–06.00. Harga tetap dapat dilihat selama pemeliharaan.',
      th: 'ระหว่าง 02:00–06:00 จะหยุดการเข้าสู่ระบบและการดูคำสั่งชั่วคราว ยังดูราคาได้ตามปกติ',
    },
  },
  {
    id: 'n-103',
    category: 'service',
    date: '2026-11-15',
    pinned: false,
    title: {
      ko: '인도네시아어·태국어 지원을 시작합니다',
      en: 'Indonesian and Thai are now supported',
      id: 'Kini tersedia dalam Bahasa Indonesia dan Thai',
      th: 'เริ่มรองรับภาษาอินโดนีเซียและภาษาไทยแล้ว',
    },
    body: {
      ko: '설정 > 언어에서 바꿀 수 있습니다. 숫자 표기도 언어에 맞춰 바뀝니다.',
      en: 'Change it in Settings > Language. Number formats follow the language too.',
      id: 'Ubah di Pengaturan > Bahasa. Format angka juga mengikuti bahasa.',
      th: 'เปลี่ยนได้ที่ ตั้งค่า > ภาษา รูปแบบตัวเลขจะเปลี่ยนตามภาษาด้วย',
    },
  },
  {
    id: 'n-102',
    category: 'event',
    date: '2026-11-10',
    pinned: false,
    title: {
      ko: '모의투자 연습 주간 이벤트',
      en: 'Practice trading week',
      id: 'Pekan latihan trading simulasi',
      th: 'สัปดาห์ฝึกซื้อขายจำลอง',
    },
    body: {
      ko: '이 앱은 모의 거래소만 사용합니다. 실제 돈이나 종목은 오가지 않습니다.',
      en: 'This app only uses a mock exchange. No real money or stocks are involved.',
      id: 'Aplikasi ini hanya memakai bursa simulasi. Tidak ada uang atau saham sungguhan.',
      th: 'แอปนี้ใช้ตลาดจำลองเท่านั้น ไม่มีเงินหรือหุ้นจริง',
    },
  },
  {
    id: 'n-101',
    category: 'service',
    date: '2026-11-01',
    pinned: false,
    title: {
      ko: '차트 화면이 새로워졌습니다',
      en: 'The chart has been redesigned',
      id: 'Tampilan grafik diperbarui',
      th: 'หน้ากราฟโฉมใหม่',
    },
    body: {
      ko: '두 손가락으로 확대·축소하고, 길게 누르면 봉 정보를 볼 수 있습니다.',
      en: 'Pinch to zoom and long-press to see bar details.',
      id: 'Cubit untuk zoom dan tekan lama untuk melihat detail.',
      th: 'ใช้สองนิ้วซูมเข้าออก และกดค้างเพื่อดูรายละเอียดแท่งเทียน',
    },
  },
];
