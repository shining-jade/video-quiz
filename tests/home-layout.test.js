const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('index.html', 'utf8');

test('홈 메뉴는 넓은 화면 4열, 중간 화면 2열, 모바일 1열을 사용한다', () => {
  assert.match(html, /\.home-cards\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(html, /@media\s*\(max-width:\s*1199px\)[\s\S]*?\.home-cards\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(html, /@media\s*\(max-width:\s*700px\)[\s\S]*?\.home-cards\s*\{[^}]*grid-template-columns:\s*1fr/);
});

test('홈 화면만 기존 wide 래퍼를 사용한다', () => {
  const home = html.match(/function screenHome\(\)[\s\S]*?function screenSetList/)[0];
  assert.match(home, /class="wrap wide"/);
  assert.equal((home.match(/class="home-card"/g) || []).length, 4);
});
