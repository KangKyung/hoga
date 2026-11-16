/**
 * QR 코드(OTP 등록용). 순수 JS 인코더(qrcode-generator)로 모듈을 계산하고 View로 그린다(네이티브 의존성 없음).
 * 한 줄의 연속된 검은 칸은 View 하나로 합쳐 뷰 수를 줄인다(33×33 기준 수백 개).
 */
import qrcode from 'qrcode-generator';
import React, {useMemo} from 'react';
import {StyleSheet, View} from 'react-native';

export function QrCode({value, size = 180, testID}: {value: string; size?: number; testID?: string}) {
  const rows = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    const out: {row: number; start: number; len: number}[] = [];
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (!qr.isDark(r, c)) {
          c++;
          continue;
        }
        const start = c;
        while (c < n && qr.isDark(r, c)) c++;
        out.push({row: r, start, len: c - start});
      }
    }
    return {n, runs: out};
  }, [value]);

  const quiet = 4; // 가장자리 여백(모듈 4칸)
  const cell = size / (rows.n + quiet * 2);
  return (
    <View testID={testID} accessibilityRole="image" style={[styles.box, {width: size, height: size}]}>
      {rows.runs.map(({row, start, len}) => (
        <View
          key={`${row}-${start}`}
          style={[
            styles.dark,
            {top: (row + quiet) * cell, left: (start + quiet) * cell, width: len * cell + 0.5, height: cell + 0.5},
          ]}
        />
      ))}
    </View>
  );
}

// 다크 모드에서도 인증 앱이 읽도록 흰 바탕·검은 칸 고정
const styles = StyleSheet.create({
  box: {backgroundColor: '#fff'},
  dark: {position: 'absolute', backgroundColor: '#000'},
});
