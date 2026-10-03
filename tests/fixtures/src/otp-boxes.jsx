// A "check your email" step with the six single-digit boxes most sign-up flows use, built the way the
// popular React OTP widgets are: controlled inputs (React owns the value, so a plain `el.value = x`
// is undone on the next render), focus jumping to the next box as you type, and a paste on any box
// spreading the code across all six. The code React registered is printed into #state.
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

const LENGTH = 6;

function CodeBoxes({ onComplete }) {
  const [digits, setDigits] = useState(Array(LENGTH).fill(''));
  const refs = useRef([]);

  const update = (next) => {
    setDigits(next);
    if (next.every(Boolean)) onComplete(next.join(''));
  };

  const spread = (start, text) => {
    const chars = text
      .replace(/\D/g, '')
      .slice(0, LENGTH - start)
      .split('');
    if (!chars.length) return;
    const next = [...digits];
    chars.forEach((c, i) => (next[start + i] = c));
    update(next);
    refs.current[Math.min(start + chars.length, LENGTH - 1)].focus();
  };

  return (
    <div className="boxes" role="group" aria-label="Verification code">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => (refs.current[i] = el)}
          id={`digit-${i}`}
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={1}
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          aria-label={`Digit ${i + 1}`}
          value={d}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '');
            if (v.length > 1) return spread(i, v);
            const next = [...digits];
            next[i] = v;
            update(next);
            if (v && i < LENGTH - 1) refs.current[i + 1].focus();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !digits[i] && i > 0) refs.current[i - 1].focus();
          }}
          onPaste={(e) => {
            e.preventDefault();
            spread(i, e.clipboardData.getData('text'));
          }}
        />
      ))}
    </div>
  );
}

function App() {
  const [code, setCode] = useState('');
  return (
    <main>
      <h1>Confirm your email</h1>
      <p>We emailed a 6-digit code to a***@example.com. Enter it below to continue your application.</p>
      <CodeBoxes onComplete={setCode} />
      <p>
        <button type="button" disabled={!code}>
          Verify
        </button>
      </p>
      <output id="state">{code}</output>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
