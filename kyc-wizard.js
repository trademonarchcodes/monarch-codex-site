(function () {
  'use strict';
  var form = document.getElementById('kycWizard');
  if (!form) return;
  var stages = Array.prototype.slice.call(form.querySelectorAll('[data-stage]'));
  var progressSteps = Array.prototype.slice.call(document.querySelectorAll('[data-progress-step]'));
  var progressLines = Array.prototype.slice.call(document.querySelectorAll('.kyc-progress-line i'));
  var next = document.getElementById('kycNext');
  var back = document.getElementById('kycBack');
  var count = document.getElementById('kycStepCount');
  var message = document.getElementById('kycMessage');
  var current = 0;
  var uploading = false;
  var selfieCaptured = false;
  var selfieStream = null;
  var selfieBlob = null;
  var selfieVideo = document.getElementById('kycSelfieVideo');
  var selfieCanvas = document.getElementById('kycSelfieCanvas');
  var selfiePreview = document.getElementById('kycSelfiePreview');
  var cameraStatus = document.getElementById('kycCameraStatus');
  var startCamera = document.getElementById('kycStartCamera');
  var captureSelfie = document.getElementById('kycCaptureSelfie');
  var retakeSelfie = document.getElementById('kycRetakeSelfie');

  function setProgress() {
    progressSteps.forEach(function (item, index) {
      item.classList.toggle('is-active', index === current);
      item.classList.toggle('is-done', index < current);
      item.setAttribute('aria-current', index === current ? 'step' : 'false');
      var line = item.querySelector('.kyc-step-dot');
      if (line) line.textContent = index < current ? '✓' : String(index + 1);
    });
    progressLines.forEach(function (line, index) {
      line.style.width = current > index ? '100%' : '0%';
    });
    count.textContent = 'Step ' + (current + 1) + ' of ' + stages.length;
    back.hidden = current === 0;
    next.innerHTML = current === stages.length - 1 ? 'Submit verification <span aria-hidden="true">→</span>' : 'Continue <span aria-hidden="true">→</span>';
  }

  function showStage(index, direction) {
    stages.forEach(function (stage, i) {
      stage.hidden = i !== index;
      stage.classList.remove('is-entering-next', 'is-entering-back');
    });
    current = index;
    stages[index].classList.add(direction === 'back' ? 'is-entering-back' : 'is-entering-next');
    setProgress();
    message.textContent = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function validateCurrentStage() {
    var fields = stages[current].querySelectorAll('input,select,textarea');
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      if (field.disabled || field.type === 'file' || field.type === 'checkbox') continue;
      if (!field.checkValidity()) {
        field.reportValidity();
        field.focus({ preventScroll: false });
        return false;
      }
    }
    if (current === 3) {
      var front = document.getElementById('kycFront');
      var consent = document.getElementById('kycConfirm');
      if (!front.files || !front.files.length) {
        message.textContent = 'Choose or take a photo of the front of your ID.';
        front.focus();
        return false;
      }
      if (!selfieCaptured) {
        message.textContent = 'Open the front camera and capture your selfie to continue.';
        if (startCamera) startCamera.focus();
        return false;
      }
      if (!consent.checked) {
        message.textContent = 'Confirm the details and images belong to you.';
        consent.focus();
        return false;
      }
    }
    return true;
  }


  function stopSelfieCamera() {
    if (selfieStream) {
      selfieStream.getTracks().forEach(function (track) { track.stop(); });
      selfieStream = null;
    }
    if (selfieVideo) selfieVideo.srcObject = null;
  }
  if (startCamera && selfieVideo && selfieCanvas) {
    startCamera.addEventListener('click', async function () {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        cameraStatus.textContent = 'This browser cannot open the camera here. Try the latest browser and allow camera permission.';
        return;
      }
      try {
        stopSelfieCamera();
        selfieStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
        selfieVideo.srcObject = selfieStream;
        selfieVideo.hidden = false;
        selfiePreview.hidden = true;
        startCamera.hidden = true;
        captureSelfie.hidden = false;
        retakeSelfie.hidden = true;
        cameraStatus.textContent = 'Center your face in the frame, then tap Capture selfie.';
      } catch (err) {
        cameraStatus.textContent = 'Camera access was blocked or unavailable. Allow camera permission and try again.';
      }
    });
    captureSelfie.addEventListener('click', function () {
      if (!selfieStream || !selfieVideo.videoWidth) {
        cameraStatus.textContent = 'Wait for the camera preview, then capture your selfie.';
        return;
      }
      selfieCanvas.width = selfieVideo.videoWidth;
      selfieCanvas.height = selfieVideo.videoHeight;
      var ctx = selfieCanvas.getContext('2d');
      ctx.translate(selfieCanvas.width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(selfieVideo, 0, 0, selfieCanvas.width, selfieCanvas.height);
      selfieCanvas.toBlob(function (blob) {
        if (!blob) {
          cameraStatus.textContent = 'Could not capture the image. Please try again.';
          return;
        }
        selfieBlob = blob;
        selfieCaptured = true;
        selfiePreview.src = URL.createObjectURL(blob);
        selfiePreview.hidden = false;
        selfieVideo.hidden = true;
        captureSelfie.hidden = true;
        retakeSelfie.hidden = false;
        startCamera.hidden = true;
        cameraStatus.textContent = 'Selfie captured in this page. It has not been uploaded.';
        stopSelfieCamera();
        message.textContent = '';
      }, 'image/jpeg', 0.9);
    });
    retakeSelfie.addEventListener('click', function () {
      selfieCaptured = false;
      selfieBlob = null;
      selfiePreview.hidden = true;
      selfiePreview.removeAttribute('src');
      retakeSelfie.hidden = true;
      startCamera.hidden = false;
      captureSelfie.hidden = true;
      cameraStatus.textContent = 'Open the front camera to take a new selfie.';
    });
    window.addEventListener('pagehide', stopSelfieCamera);
  }

  next.addEventListener('click', function () {
    if (uploading || !validateCurrentStage()) return;
    if (current < stages.length - 1) {
      showStage(current + 1, 'next');
      return;
    }
    // No form is submitted until private document storage and the DB write endpoint are deployed.
    message.textContent = 'Secure submission is not active yet. Nothing was uploaded or saved. Please do not use real identity documents on this preview.';
    var notice = document.getElementById('kycSubmitNotice');
    if (notice) notice.textContent = 'Submission is not connected yet. Your selected images and entered details remain in this browser only and have not been sent to Monarch Codex.';
  });

  back.addEventListener('click', function () {
    if (current > 0) showStage(current - 1, 'back');
  });

  form.querySelectorAll('input[type="file"][data-preview]').forEach(function (input) {
    input.addEventListener('change', function () {
      var target = document.getElementById(input.getAttribute('data-preview'));
      if (!target) return;
      var file = input.files && input.files[0];
      if (!file) {
        target.removeAttribute('src');
        target.hidden = true;
        return;
      }
      if (!/^image\/(jpeg|png)$/.test(file.type) || file.size > 8 * 1024 * 1024) {
        input.value = '';
        target.removeAttribute('src');
        target.hidden = true;
        message.textContent = 'Choose a JPG or PNG image no larger than 8 MB.';
        return;
      }
      target.src = URL.createObjectURL(file);
      target.hidden = false;
      message.textContent = '';
    });
  });

  setProgress();
})();