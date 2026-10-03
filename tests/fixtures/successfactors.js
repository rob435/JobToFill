// Behaviour shared by the SuccessFactors fixture pages: a stand-in for SFreCAPTCHA (Google reCAPTCHA v2), the
// page-level error box, SuccessFactors' document tiles ("Upload a Resume" -> "Upload from Device / Upload from
// Dropbox / Sign in with Google"), and the emailed one-time passcode step that follows "Create Account".
window.SF = (function () {
  'use strict';

  /** Show a message in the page's error box (#uiErrorContainer_2), as SuccessFactors does. */
  function error(html) {
    const box = document.getElementById('uiErrorContainer_2');
    document.getElementById('uiErrorMsg').innerHTML = html;
    box.style.display = 'block';
  }

  /**
   * The reCAPTCHA widget: only a trusted click (a person, or the test driving the browser) solves it. Any script
   * click is counted in sessionStorage.untrustedCaptcha, which the tests check stays unset.
   */
  function fakeRecaptcha(container, copyTo) {
    const widget = document.createElement('div');
    widget.className = 'g-recaptcha';
    widget.setAttribute('data-sitekey', '6LcIRvssAAAAABQFcFPxVEwioK9odHeHybgtzHjz');
    widget.innerHTML =
      '<div class="recaptcha-checkbox" role="checkbox" aria-checked="false" tabindex="0" aria-labelledby="recaptcha-anchor-label"></div>' +
      '<label id="recaptcha-anchor-label">I\'m not a robot</label>' +
      '<textarea id="g-recaptcha-response" name="g-recaptcha-response" class="g-recaptcha-response" style="display: none"></textarea>';
    container.append(widget);
    const box = widget.querySelector('.recaptcha-checkbox');
    box.addEventListener('click', (e) => {
      if (!e.isTrusted) {
        sessionStorage.setItem('untrustedCaptcha', 'clicked');
        return;
      }
      box.setAttribute('aria-checked', 'true');
      const token = '03AFcWeA' + Math.random().toString(36).slice(2);
      widget.querySelector('textarea').value = token;
      if (copyTo) document.getElementById(copyTo).value = token;
    });
  }

  /**
   * A document tile: clicking it makes the file box (N+1):_file at once, but only the box armed by "Upload from
   * Device" uploads; a file put into it without that stays "Uploading…" for ever, as on the real site.
   */
  function tile(link, onUploaded) {
    const holder = link.closest('.tile');
    let input = null;
    let armed = false;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const n = parseInt(link.id, 10) + 1;
      if (!input) {
        input = document.createElement('input');
        input.type = 'file';
        input.id = `${n}:_file`;
        input.name = `${n}:_file`;
        input.style.display = 'none';
        input.addEventListener('change', () => {
          if (!input.files.length) return;
          const status = holder.querySelector('.status') || holder.appendChild(document.createElement('span'));
          status.className = 'status';
          status.textContent = 'Uploading...';
          if (!armed) return; // stuck, like the real widget
          setTimeout(() => {
            holder.innerHTML = `<span class="fileName">${input.files[0].name}</span> <span class="confirm">File is uploaded successfully</span>`;
            if (onUploaded) onUploaded(input.files[0]);
          }, 200);
        });
        holder.append(input);
      }
      document.querySelectorAll('.sourceMenu').forEach((m) => m.remove());
      const menu = document.createElement('div');
      menu.className = 'sourceMenu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', 'Select a source for your file upload');
      for (const [label, run] of [
        ['Upload from Device', () => ((armed = true), input.click())],
        ['Upload from Dropbox', () => sessionStorage.setItem('cloud', 'Dropbox')],
        ['Sign in with Google', () => sessionStorage.setItem('cloud', 'Google')],
      ]) {
        const item = document.createElement('a');
        item.href = 'javascript:void(0)';
        item.setAttribute('role', 'menuitem');
        item.textContent = label;
        item.addEventListener('click', (ev) => {
          ev.preventDefault();
          menu.remove();
          run();
        });
        menu.append(item);
      }
      holder.append(menu);
    });
  }

  /** The emailed passcode step that replaces the sign-up fields after "Create Account" (RCMOTPAuthentication). */
  function otpStep(container, email, code, onSuccess) {
    container.innerHTML =
      '<table class="axial noborder bottomspace table table-condensed" role="presentation">' +
      `<tr><td class="col-sm-4"><label for="otpEmail"><strong>Email Address:</strong></label></td><td><span id="otpEmail">${email}</span></td></tr>` +
      '<tr><td class="col-sm-4"></td><td><span id="checkEmailMsg" tabindex="0" role="region">We’ve sent a one-time password to your email address. In case you don’t find this email in your primary inbox, please check your spam or bulk email folders.</span></td></tr>' +
      '<tr><td class="col-sm-4"><label for="passcode" title="Required"><span class="required requiredAccessible" aria-hidden="true">*</span><strong>Passcode:</strong></label></td>' +
      '<td><div class="textContainer"><input type="password" name="passcode" id="passcode" class="active" aria-describedby="passcode_error" aria-required="true" maxlength="10" /><span class="otpToggle" tabindex="0">Show</span></div>' +
      '<div id="passcode_error" class="rcmValidationMsgArea hide" aria-live="assertive"></div></td></tr>' +
      '<tr><td class="col-sm-4"></td><td class="button_row mobileApplyButtonRow"><span id="activeBtnSpan" class="aquabtn active"><span><button type="button" id="continueBtn" name="continueBtn">Continue</button></span></span>' +
      '<span id="resendPasscode" tabindex="0" class="hide">Resend passcode</span></td></tr></table>';
    document.getElementById('continueBtn').addEventListener('click', () => {
      const typed = document.getElementById('passcode').value;
      const err = document.getElementById('passcode_error');
      if (typed !== code) {
        err.textContent = 'The passcode entered is incorrect. Please try again.';
        err.classList.remove('hide');
        return;
      }
      onSuccess();
    });
  }

  return { error, fakeRecaptcha, tile, otpStep };
})();
