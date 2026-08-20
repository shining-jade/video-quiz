const test = require('node:test');
const assert = require('node:assert/strict');
const ImageLightboxCore = require('../image-lightbox-core.js');

test('이미지를 열면 원본 주소와 설명을 보존하고 Esc로 닫는다', () => {
  const changes = [];
  const lightbox = ImageLightboxCore.create(state => changes.push(state));

  assert.equal(lightbox.open('https://example.com/question.jpg', '문항 이미지'), true);
  assert.deepEqual(lightbox.current(), {
    open: true,
    src: 'https://example.com/question.jpg',
    alt: '문항 이미지'
  });
  assert.equal(lightbox.keydown('Enter'), false);
  assert.equal(lightbox.keydown('Escape'), true);
  assert.deepEqual(lightbox.current(), { open: false, src: '', alt: '' });
  assert.equal(changes.length, 2);
});

test('빈 이미지 주소는 확대창을 열지 않는다', () => {
  const lightbox = ImageLightboxCore.create();

  assert.equal(lightbox.open('  ', '해설 이미지'), false);
  assert.deepEqual(lightbox.current(), { open: false, src: '', alt: '' });
});
