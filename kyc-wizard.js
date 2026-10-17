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
  var docType = document.getElementById('kycDocType');
  var docNumber = document.getElementById('kycDocNumber');
  var docNumberError = document.getElementById('kycDocNumberError');
  var saveTimer = null;
  var draftNotice = null;
  var draftSaving = false;
  var draftLoaded = false;
  function draftFields() {
    var result = {};
    ['legalFullName','dateOfBirth','phoneNumber','contactEmail','countryCode','stateRegion','localityLga','streetAddress','documentType','documentIssuerCountry','documentNumber'].forEach(function (name) {
      var field = form.elements.namedItem(name);
      if (field && typeof field.value === 'string') result[name] = field.value;
    });
    return result;
  }
  function setDraftNotice(text) {
    if (!draftNotice) {
      draftNotice = document.createElement('p');
      draftNotice.className = 'kyc-form-message';
      draftNotice.setAttribute('role','status');
      draftNotice.setAttribute('aria-live','polite');
      var actions = form.querySelector('.kyc-actions');
      if (actions && actions.parentNode) actions.parentNode.insertBefore(draftNotice, actions);
    }
    draftNotice.textContent = text;
  }
  function saveDraft() {
    if (uploading || !draftLoaded) return;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(function () {
      var csrf = form.querySelector('input[name="_csrf"]');
      if (!csrf) return;
      draftSaving = true;
      fetch('/kyc/draft', {
        method:'POST', credentials:'same-origin',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({_csrf:csrf.value,fields:draftFields(),currentStep:current})
      }).then(function (response) {
        if (!response.ok) throw new Error('Draft save unavailable');
        return response.json();
      }).then(function () {
        setDraftNotice('Progress saved securely. You can return and continue from this step.');
      }).catch(function () {
        setDraftNotice('Your progress could not be saved to your account right now. Keep this page open until saving is available.');
      }).finally(function () { draftSaving = false; });
    }, 650);
  }
  function restoreDraft() {
    fetch('/kyc/draft',{credentials:'same-origin',headers:{'Accept':'application/json'}})
      .then(function (response) { if (!response.ok) throw new Error('draft unavailable'); return response.json(); })
      .then(function (body) {
        if (body.draft && typeof body.draft === 'object') {
          Object.keys(body.draft).forEach(function (name) {
            var field = form.elements.namedItem(name);
            if (field && typeof body.draft[name] === 'string') field.value = body.draft[name];
          });
          var restoredStep = Math.max(0,Math.min(stages.length-1,Number(body.currentStep)||0));
          showStage(restoredStep,'next');
          setDraftNotice('Your saved progress has been restored. For your security, identity photos and selfies must be selected or captured again.');
        }
      }).catch(function () {
        setDraftNotice('Progress saving becomes available when secure draft storage is configured.');
      }).finally(function () { draftLoaded = true; });
  }

  function isNinDocument() {
    return docType && docType.value === 'national_id' && document.getElementById('kycDocCountry').value === 'NG';
  }

  function validateDocumentNumber(showError) {
    if (!docNumber || !docNumberError) return true;
    var value = docNumber.value.trim();
    var invalid = isNinDocument() && value.length > 0 && !/^\d{11}$/.test(value);
    docNumberError.hidden = !invalid;
    docNumber.setAttribute('aria-invalid', invalid ? 'true' : 'false');
    if (invalid) docNumberError.textContent = value.length < 11 ? 'NIN must contain 11 digits.' : 'NIN must contain exactly 11 digits.';
    if (showError && isNinDocument() && !/^\d{11}$/.test(value)) {
      docNumberError.hidden = false;
      docNumberError.textContent = value.length < 11 ? 'NIN must contain 11 digits.' : 'NIN must contain exactly 11 digits.';
      docNumber.focus();
      return false;
    }
    return !(isNinDocument() && value.length > 0 && !/^\d{11}$/.test(value));
  }

  if (docNumber) {
    docNumber.addEventListener('input', function () {
      if (isNinDocument()) {
        docNumber.value = docNumber.value.replace(/\D/g, '').slice(0, 11);
      }
      validateDocumentNumber(false);
    });
    docNumber.addEventListener('blur', function () { validateDocumentNumber(false); });
  }
  if (docType) docType.addEventListener('change', function () {
    if (docNumber) docNumber.value = '';
    validateDocumentNumber(false);
    if (docNumber) {
      docNumber.inputMode = isNinDocument() ? 'numeric' : 'text';
      docNumber.maxLength = isNinDocument() ? 11 : 80;
      docNumber.placeholder = '';
    }
  });

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
    if (draftLoaded) saveDraft();
  }

  function validateCurrentStage() {
    if (current === 2 && !validateDocumentNumber(true)) return false;
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
      var backImage = document.getElementById('kycBackImage');
      var consent = document.getElementById('kycConfirm');
      var selectedDocType = docType ? docType.value : '';
      if (!front.files || !front.files.length) {
        message.textContent = 'Choose a clear photo of the front of your identity document.';
        front.focus();
        return false;
      }
      if (selectedDocType !== 'passport' && (!backImage.files || !backImage.files.length)) {
        message.textContent = 'Add the back of your identity document to continue.';
        backImage.focus();
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

  form.addEventListener('input', saveDraft);
  form.addEventListener('change', saveDraft);
  restoreDraft();

  next.addEventListener('click', function () {
    if (uploading || !validateCurrentStage()) return;
    if (current < stages.length - 1) {
      showStage(current + 1, 'next');
      return;
    }
    if (!selfieBlob) {
      message.textContent = 'Capture your selfie before submitting.';
      return;
    }
    var notice = document.getElementById('kycSubmitNotice');
    var data = new FormData(form);
    data.set('confirmOwnership', document.getElementById('kycConfirm').checked ? 'yes' : 'no');
    data.set('selfie', new File([selfieBlob], 'selfie.jpg', { type: 'image/jpeg' }));
    next.disabled = true;
    uploading = true;
    message.textContent = 'Submitting securely…';
    if (notice) notice.textContent = 'Uploading your verification securely. Please keep this page open.';
    fetch('/kyc/submit', { method: 'POST', body: data, credentials: 'same-origin' })
      .then(function (response) { return response.json().catch(function () { return {}; }).then(function (body) { if (!response.ok) throw new Error(body.error || 'Submission failed.'); return body; }); })
      .then(function (body) {
        message.textContent = 'Verification submitted successfully. Reference: ' + body.submissionId + '.';
        if (notice) notice.textContent = 'Your verification has been received and is pending administrator review. Opening your review status…';
        next.textContent = 'Submitted';
        window.setTimeout(function () { window.location.assign('/kyc'); }, 700);
      })
      .catch(function (error) {
        message.textContent = error.message || 'Secure submission failed. Please try again later.';
        if (notice) notice.textContent = 'Your submission was not confirmed. Please correct any errors or try again.';
        next.disabled = false;
        uploading = false;
      });
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