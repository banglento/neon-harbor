// Poll keyboard and mouse once per frame; pressed keys and pointer deltas are consumed only once.
const PREVENT_DEFAULT = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab',
]);

export function createInput(target = document.getElementById('world')) {
  const keys = new Set();
  const pressed = new Set();
  let mouseDX = 0;
  let mouseDY = 0;
  let dragging = false;
  let pointerLocked = false;

  function keyDown(event) {
    if (PREVENT_DEFAULT.has(event.code)) event.preventDefault();
    if (!keys.has(event.code)) pressed.add(event.code);
    keys.add(event.code);
  }

  function keyUp(event) {
    keys.delete(event.code);
  }

  function mouseDown(event) {
    if (event.button !== 0 && event.button !== 2) return;
    dragging = true;
    target?.focus?.({ preventScroll: true });
  }

  function mouseUp() {
    dragging = false;
  }

  function mouseMove(event) {
    if (!pointerLocked && !dragging) return;
    mouseDX += pointerLocked ? event.movementX : event.movementX;
    mouseDY += pointerLocked ? event.movementY : event.movementY;
  }

  function lockChange() {
    pointerLocked = document.pointerLockElement === target;
  }

  function blur() {
    keys.clear();
    pressed.clear();
    dragging = false;
  }

  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);
  window.addEventListener('blur', blur);
  target?.addEventListener('pointerdown', mouseDown);
  window.addEventListener('pointerup', mouseUp);
  window.addEventListener('pointermove', mouseMove);
  target?.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener('pointerlockchange', lockChange);

  return {
    keys,
    isDown(code) { return keys.has(code); },
    wasPressed(code) { return pressed.has(code); },
    consumePressed(code) {
      const value = pressed.has(code);
      pressed.delete(code);
      return value;
    },
    consumeMouseDelta() {
      const delta = { x: mouseDX, y: mouseDY };
      mouseDX = 0;
      mouseDY = 0;
      return delta;
    },
    requestPointerLock() {
      if (target?.requestPointerLock) target.requestPointerLock();
    },
    exitPointerLock() {
      if (document.pointerLockElement) document.exitPointerLock();
    },
    get pointerLocked() { return pointerLocked; },
    destroy() {
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', blur);
      target?.removeEventListener('pointerdown', mouseDown);
      window.removeEventListener('pointerup', mouseUp);
      window.removeEventListener('pointermove', mouseMove);
      document.removeEventListener('pointerlockchange', lockChange);
    },
  };
}
