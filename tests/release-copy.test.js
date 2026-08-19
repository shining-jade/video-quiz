const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = file => fs.readFileSync(file, 'utf8');

test('README는 자동 검증과 아직 닫힌 프로덕션 배포 게이트를 구분한다', () => {
  const readme = read('README.md');

  assert.match(readme, /자동 테스트[^\n]*통과/);
  assert.match(readme, /프로덕션[^\n]*(이전|마이그레이션)[^\n]*(미실행|남아)/);
  assert.match(readme, /엄격한 규칙[^\n]*(게시|배포)[^\n]*(미실행|남아)/);
  assert.match(readme, /실제 브라우저[^\n]*(미검증|남아|차단)/);
  assert.doesNotMatch(readme, /Firebase 콘솔 규칙 게시, 기존 세트 이전[^\n]*검증을 완료했습니다/);
});

test('사용자 안내는 Google 관리자 역할과 세트 소유권을 정확히 설명한다', () => {
  const html = read('index.html');
  const readme = read('README.md');

  assert.match(html, /관리자 통합 조회[\s\S]*?승인된 Google 관리자 계정이 필요합니다/);
  assert.doesNotMatch(html, /관리자 통합 조회[\s\S]{0,200}?비밀번호가 필요합니다/);
  assert.match(html, /부팅 — Google 교사 인증 상태 확인 후 라우팅/);
  assert.doesNotMatch(html, /교사도 학생도 아무것도 로그인하지 않습니다/);
  assert.match(readme, /\| ✏️ 편집 \| 소유한 세트 내용을 고칩니다/);
});
