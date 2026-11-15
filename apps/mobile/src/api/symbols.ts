import {SERVER} from '../config';

export interface SymbolInfo {
  code: string;
  name: string;
  basePrice: number;
  lastPrice: number;
  tickSize: number;
  limits: {lower: number; upper: number};
}

export async function fetchSymbols(signal?: AbortSignal): Promise<SymbolInfo[]> {
  const res = await fetch(`${SERVER.http}/symbols`, {signal});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SymbolInfo[];
}
