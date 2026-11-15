/** hoga-core 버전 문자열 */
export function coreVersion(): string;

/** 국내 주식 호가가격단위(원). 0 이하 가격은 0. 정수가 아니면 TypeError. */
export function tickSize(price: number): number;
