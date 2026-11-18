// input.js — keyboard + mouse state with a once-per-frame "pressed" set.
// main.js creates one instance and passes it through ctx.input.
//
// Usage:
//   const input = createInput(renderer.domElement);
//   input.axis();            // { x, z } from WASD, x = strafe right, z = forward
//   input.isDown('sprint');  // action names below
//   input.wasPressed('enter');
//   input.mouse.dx / .dy     // orbit delta accumulated this frame
//   input.endFrame();        // clears pressed + mouse deltas; call last in the loop

const ACTIONS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  enter: ['KeyE'],
  punch: ['KeyF', 'Space'],
  pause: ['Escape', 'KeyP'],
  mute: ['KeyM'],
  map: ['Tab'],
  interact: ['KeyE', 'Enter'],
  horn: ['KeyH'],
  handbrake: ['Space'],
};

export const INPUT_ACTIONS = ACTIONS;

export function createInput(canvas) {
  const down = new Set();
  const pressed = new Set();

  const mouse = {
    dx: 0,
    dy: 0,
    wheel: 0,
    left: false,
    right: false,
    clicked: false,
    dragging: false,
    locked: false,
  };

  let lastX = 0;
  let lastY = 0;

  function onKeyDown(event) {
    if (event.repeat) {
      // Still suppress browser scrolling for game keys.
      if (ACTIONS.forward.includes(event.code) || ACTIONS.back.includes(event.code)) {
        event.preventDefault();
      }
      return;
    }
    down.add(event.code);
    pressed.add(event.code);
    if (
      ACTIONS.forward.includes(event.code) ||
      ACTIONS.back.includes(event.code) ||
      event.code === 'Tab' ||
      event.code === 'Space'
    ) {
      event.preventDefault();
    }
  }

  function onKeyUp(event) {
    down.delete(event.code);
  }

  function clearAll() {
    down.clear();
    pressed.clear();
    mouse.left = false;
    mouse.right = false;
    mouse.dragging = false;
  }

  function onPointerDown(event) {
    lastX = event.clientX;
    lastY = event.clientY;
    if (event.button === 0) {
      mouse.left = true;
      mouse.clicked = true;
      mouse.dragging = true;
    }
    if (event.button === 2) mouse.right = true;
  }

  function onPointerUp(event) {
    if (event.button === 0) {
      mouse.left = false;
      mouse.dragging = false;
    }
    if (event.button === 2) mouse.right = false;
  }

  function onPointerMove(event) {
    if (mouse.locked) {
      mouse.dx += event.movementX || 0;
      mouse.dy += event.movementY || 0;
      return;
    }
    if (!mouse.dragging) return;
    mouse.dx += event.clientX - lastX;
    mouse.dy += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
  }

  function onWheel(event) {
    mouse.wheel += event.deltaY;
    event.preventDefault();
  }

  function onLockChange() {
    mouse.locked = document.pointerLockElement === canvas;
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', clearAll);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('pointerlockchange', onLockChange);

  function anyDown(action) {
    const codes = ACTIONS[action];
    if (!codes) return down.has(action);
    for (const code of codes) if (down.has(code)) return true;
    return false;
  }

  function anyPressed(action) {
    const codes = ACTIONS[action];
    if (!codes) return pressed.has(action);
    for (const code of codes) if (pressed.has(code)) return true;
    return false;
  }

  const api = {
    mouse,

    isDown(action) {
      return anyDown(action);
    },
    wasPressed(action) {
      return anyPressed(action);
    },
    codeDown(code) {
      return down.has(code);
    },
    codePressed(code) {
      return pressed.has(code);
    },
    // Raw digital axes: x = right, z = forward.
    axis() {
      return {
        x: (anyDown('right') ? 1 : 0) - (anyDown('left') ? 1 : 0),
        z: (anyDown('forward') ? 1 : 0) - (anyDown('back') ? 1 : 0),
      };
    },
    sprint() {
      return anyDown('sprint');
    },
    // Mouse orbit delta in radians, accumulated since the last endFrame().
    lookDelta(sensitivity) {
      return { yaw: -mouse.dx * sensitivity, pitch: -mouse.dy * sensitivity };
    },
    consumeClick() {
      if (!mouse.clicked) return false;
      mouse.clicked = false;
      return true;
    },
    requestPointerLock() {
      if (canvas.requestPointerLock) canvas.requestPointerLock();
    },
    releasePointerLock() {
      if (document.pointerLockElement) document.exitPointerLock();
    },
    endFrame() {
      pressed.clear();
      mouse.dx = 0;
      mouse.dy = 0;
      mouse.wheel = 0;
      mouse.clicked = false;
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearAll);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('wheel', onWheel);
      document.removeEventListener('pointerlockchange', onLockChange);
    },
  };

  return api;
}
