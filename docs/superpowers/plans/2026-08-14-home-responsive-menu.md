# Home Responsive Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 홈 화면 메뉴 카드 4개를 큰 화면에서는 4열, 중간 화면에서는 2열, 모바일에서는 1열로 표시한다.

**Architecture:** 기존 단일 페이지 앱의 홈 전용 `.home-cards` CSS만 반응형으로 조정하고, 홈 렌더러의 래퍼에 기존 `.wide` 클래스를 재사용한다. 다른 화면의 공통 `.wrap` 폭과 카드 컴포넌트는 변경하지 않는다.

**Tech Stack:** HTML, CSS, 바닐라 JavaScript, Node.js 내장 테스트 러너

## Global Constraints

- 1200px 이상에서는 4열 한 행을 사용한다.
- 701px~1199px에서는 2열 2행을 사용한다.
- 700px 이하에서는 1열 4행을 사용한다.
- 홈 화면만 최대 1400px 폭을 사용한다.
- 카드의 내용, 순서, 링크와 진행 흐름 문구는 변경하지 않는다.

---

### Task 1: 홈 메뉴 반응형 그리드

**Files:**
- Create: `tests/home-layout.test.js`
- Modify: `index.html:145-158`
- Modify: `index.html:1043-1064`

**Interfaces:**
- Consumes: 기존 `.wrap.wide`, `.home-cards`, `screenHome()` 렌더링 구조
- Produces: 폭에 따라 4열, 2열, 1열로 변하는 홈 메뉴 그리드

- [ ] **Step 1: 실패하는 구조 테스트 작성**

```js
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
  const home = html.match(/function screenHome\(\)[\s\S]*?function screenSets/)[0];
  assert.match(home, /class="wrap wide"/);
  assert.equal((home.match(/class="home-card"/g) || []).length, 4);
});
```

- [ ] **Step 2: 새 테스트가 실패하는지 확인**

Run: `node --test tests/home-layout.test.js`

Expected: 4열 CSS와 홈의 `wrap wide`가 아직 없어서 FAIL

- [ ] **Step 3: 최소 CSS와 홈 래퍼 변경 구현**

```css
.home-cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}
@media (max-width: 1199px) {
  .home-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 700px) {
  .home-cards { grid-template-columns: 1fr; }
}
```

`screenHome()`의 최상위 본문 래퍼를 다음처럼 변경한다.

```js
'<div class="wrap wide">' +
```

- [ ] **Step 4: 새 테스트와 전체 테스트 실행**

Run: `node --test tests/home-layout.test.js`

Expected: PASS 2, FAIL 0

Run: `node --test tests/*.test.js`

Expected: 기존 테스트와 새 테스트 모두 PASS

- [ ] **Step 5: 브라우저 회귀 확인**

로컬 서버에서 홈 화면을 열고 1400px 이상, 900px, 390px 뷰포트에서 각각 4열, 2열, 1열인지 확인한다. 네 카드의 순서와 링크가 `make`, `sets`, `join`, `admin`으로 유지되고 콘솔 오류가 없는지 확인한다.

- [ ] **Step 6: 커밋**

```bash
git add index.html tests/home-layout.test.js
git commit -m "홈 메뉴를 화면 폭에 맞게 반응형으로 배열"
```

### Task 2: 병합 및 배포 검증

**Files:**
- Modify: 없음

**Interfaces:**
- Consumes: Task 1의 반응형 홈 화면
- Produces: GitHub Pages에 반영된 검증 완료 버전

- [ ] **Step 1: 변경 무결성 검사**

Run: `git diff --check`

Expected: 출력 없음

- [ ] **Step 2: main 푸시**

```bash
git push origin main
```

- [ ] **Step 3: 공개 사이트 확인**

`https://shining-jade.github.io/video-quiz/`에서 넓은 화면 4열 배치와 콘솔 오류 0건을 확인한다.

