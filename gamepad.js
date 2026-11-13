/*
 * Browser Gamepad bridge for the Pixelsuft Xash3D Emscripten port.
 * Uses the browser Gamepad API and forwards controller input as DOM events
 * to the existing SDL/Emscripten keyboard and mouse handlers.
 */
(function () {
  'use strict';

  var statusNode;
  var activePad = null;
  var animationFrame = 0;
  var previousButtons = [];
  var heldKeys = Object.create(null);
  var enabled = true;
  var deadzone = 0.18;
  var lookSensitivity = 14;
  var lastFrameTime = 0;

  var keyMap = {
    forward: { key: 'w', code: 'KeyW', keyCode: 87 },
    back: { key: 's', code: 'KeyS', keyCode: 83 },
    left: { key: 'a', code: 'KeyA', keyCode: 65 },
    right: { key: 'd', code: 'KeyD', keyCode: 68 },
    jump: { key: ' ', code: 'Space', keyCode: 32 },
    crouch: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
    use: { key: 'e', code: 'KeyE', keyCode: 69 },
    reload: { key: 'r', code: 'KeyR', keyCode: 82 },
    prevWeapon: { key: '[', code: 'BracketLeft', keyCode: 219 },
    nextWeapon: { key: ']', code: 'BracketRight', keyCode: 221 },
    slot1: { key: '1', code: 'Digit1', keyCode: 49 },
    slot2: { key: '2', code: 'Digit2', keyCode: 50 },
    slot3: { key: '3', code: 'Digit3', keyCode: 51 },
    slot4: { key: '4', code: 'Digit4', keyCode: 52 },
    menu: { key: 'Escape', code: 'Escape', keyCode: 27 }
  };

  function setStatus(message) {
    if (statusNode) statusNode.textContent = message;
  }

  function keyboardEvent(type, info) {
    var event;
    try {
      event = new KeyboardEvent(type, {
        key: info.key,
        code: info.code,
        bubbles: true,
        cancelable: true
      });
      // Older Emscripten SDL builds inspect keyCode/which.
      try {
        Object.defineProperty(event, 'keyCode', { get: function () { return info.keyCode; } });
        Object.defineProperty(event, 'which', { get: function () { return info.keyCode; } });
      } catch (ignore) {}
    } catch (error) {
      event = document.createEvent('Event');
      event.initEvent(type, true, true);
      event.key = info.key;
      event.keyCode = info.keyCode;
      event.which = info.keyCode;
      event.code = info.code;
    }
    document.dispatchEvent(event);
  }

  function setKey(name, down) {
    var info = keyMap[name];
    if (!info || !!heldKeys[name] === !!down) return;
    heldKeys[name] = !!down;
    keyboardEvent(down ? 'keydown' : 'keyup', info);
  }

  function releaseAllKeys() {
    Object.keys(heldKeys).forEach(function (name) {
      setKey(name, false);
    });
    setMouseButton(0, false);
    setMouseButton(2, false);
  }

  function setMouseButton(button, down) {
    var key = 'mouse' + button;
    if (!!heldKeys[key] === !!down) return;
    heldKeys[key] = !!down;
    var canvas = document.getElementById('canvas') || document;
    var event;
    try {
      event = new MouseEvent(down ? 'mousedown' : 'mouseup', {
        button: button,
        buttons: down ? (button === 0 ? 1 : 2) : 0,
        bubbles: true,
        cancelable: true,
        view: window
      });
    } catch (error) {
      event = document.createEvent('MouseEvents');
      event.initMouseEvent(down ? 'mousedown' : 'mouseup', true, true, window, 1,
        0, 0, 0, 0, false, false, false, false, button, null);
    }
    canvas.dispatchEvent(event);
  }

  function moveMouse(dx, dy) {
    if (!dx && !dy) return;
    var canvas = document.getElementById('canvas') || document;
    var event;
    try {
      event = new MouseEvent('mousemove', {
        movementX: dx,
        movementY: dy,
        bubbles: true,
        cancelable: true,
        view: window
      });
      // Some browsers don't expose synthetic movementX/Y from init options.
      try {
        Object.defineProperty(event, 'movementX', { get: function () { return dx; } });
        Object.defineProperty(event, 'movementY', { get: function () { return dy; } });
      } catch (ignore) {}
    } catch (error) {
      event = document.createEvent('MouseEvents');
      event.initMouseEvent('mousemove', true, true, window, 0,
        0, 0, dx, dy, false, false, false, false, 0, null);
      try {
        Object.defineProperty(event, 'movementX', { get: function () { return dx; } });
        Object.defineProperty(event, 'movementY', { get: function () { return dy; } });
      } catch (ignore) {}
    }
    canvas.dispatchEvent(event);
  }

  function axis(value) {
    return Math.abs(value) < deadzone ? 0 : value;
  }

  function buttonDown(pad, index) {
    var button = pad.buttons[index];
    return !!button && (button.pressed || button.value > 0.55);
  }

  function buttonEdge(pad, index, action) {
    var down = buttonDown(pad, index);
    var wasDown = !!previousButtons[index];
    if (down !== wasDown) action(down);
    previousButtons[index] = down;
  }

  function poll() {
    animationFrame = 0;
    if (!enabled) return;

    var pads = navigator.getGamepads ? navigator.getGamepads() : [];
    var pad = null;
    for (var i = 0; i < pads.length; i++) {
      if (pads[i] && pads[i].connected) {
        pad = pads[i];
        break;
      }
    }

    if (!pad) {
      if (activePad) {
        releaseAllKeys();
        activePad = null;
        previousButtons = [];
        setStatus('Controller disconnected');
      }
      schedulePoll();
      return;
    }

    if (!activePad || activePad.index !== pad.index) {
      releaseAllKeys();
      activePad = pad;
      previousButtons = [];
      setStatus('Controller: ' + (pad.id || 'Connected'));
    }

    var lx = axis(pad.axes[0] || 0);
    var ly = axis(pad.axes[1] || 0);
    var rx = axis(pad.axes[2] || 0);
    var ry = axis(pad.axes[3] || 0);

    setKey('forward', ly < 0);
    setKey('back', ly > 0);
    setKey('left', lx < 0);
    setKey('right', lx > 0);

    var now = Date.now();
    var elapsed = lastFrameTime ? Math.min((now - lastFrameTime) / 16.67, 2) : 1;
    lastFrameTime = now;
    moveMouse(Math.round(rx * lookSensitivity * elapsed),
      Math.round(ry * lookSensitivity * elapsed));

    buttonEdge(pad, 0, function (down) { setKey('jump', down); });       // A
    buttonEdge(pad, 1, function (down) { setKey('crouch', down); });     // B
    buttonEdge(pad, 2, function (down) { setKey('use', down); });        // X
    buttonEdge(pad, 3, function (down) { setKey('reload', down); });    // Y
    buttonEdge(pad, 4, function (down) { setKey('prevWeapon', down); }); // LB
    buttonEdge(pad, 5, function (down) { setKey('nextWeapon', down); }); // RB
    buttonEdge(pad, 6, function (down) { setMouseButton(2, down); });   // LT
    buttonEdge(pad, 7, function (down) { setMouseButton(0, down); });   // RT
    buttonEdge(pad, 8, function (down) { if (down) setKey('slot1', true); else setKey('slot1', false); });
    buttonEdge(pad, 9, function (down) { setKey('menu', down); });      // Start

    // D-pad: up/down select weapon slots; left/right cycle weapons.
    buttonEdge(pad, 12, function (down) { setKey('slot1', down); });
    buttonEdge(pad, 13, function (down) { setKey('slot2', down); });
    buttonEdge(pad, 14, function (down) { setKey('prevWeapon', down); });
    buttonEdge(pad, 15, function (down) { setKey('nextWeapon', down); });

    schedulePoll();
  }

  function schedulePoll() {
    if (!animationFrame) animationFrame = window.requestAnimationFrame(poll);
  }

  function start() {
    if (!navigator.getGamepads) {
      setStatus('Gamepad API unavailable in this browser');
      return;
    }
    schedulePoll();
  }

  function stop() {
    enabled = false;
    if (animationFrame) window.cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    releaseAllKeys();
    activePad = null;
    setStatus('Controller support paused');
  }

  window.addEventListener('gamepadconnected', function (event) {
    setStatus('Controller connected: ' + (event.gamepad.id || 'Gamepad'));
    start();
  });
  window.addEventListener('gamepaddisconnected', function () {
    releaseAllKeys();
    activePad = null;
    previousButtons = [];
    setStatus('Controller disconnected');
  });
  window.addEventListener('blur', releaseAllKeys);

  window.addEventListener('DOMContentLoaded', function () {
    statusNode = document.getElementById('gamepadStatus');
    var toggle = document.getElementById('gamepadToggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        if (enabled) {
          stop();
          toggle.textContent = 'Enable Controller';
        } else {
          enabled = true;
          toggle.textContent = 'Disable Controller';
          start();
        }
      });
    }
    start();
  });
})();