/* Tweaks island — a tiny React root that renders only the floating Tweaks panel
   and pushes values into the vanilla app via window.applyTweaks(). */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "formality": "neutral",
  "model": "fast",
  "autofill": false,
  "placeholders": true,
  "showChars": true
}/*EDITMODE-END*/;

function TweaksApp() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  React.useEffect(() => {
    if (window.applyTweaks) window.applyTweaks(t);
  }, [t.formality, t.model, t.autofill, t.placeholders, t.showChars]);

  return (
    <TweaksPanel title="Tweaks">
      <TweakSection label="AI translation" />
      <TweakRadio
        label="Formality"
        value={t.formality}
        options={[
          { value: 'neutral', label: 'Neutral' },
          { value: 'formal',  label: 'Formal' },
          { value: 'casual',  label: 'Casual' },
        ]}
        onChange={(v) => setTweak('formality', v)}
      />
      <TweakRadio
        label="Model"
        value={t.model}
        options={[
          { value: 'fast',    label: 'Fast' },
          { value: 'quality', label: 'Quality' },
        ]}
        onChange={(v) => setTweak('model', v)}
      />
      <TweakToggle label="Auto-fill missing on open" value={t.autofill} onChange={(v) => setTweak('autofill', v)} />
      <TweakSection label="Editor" />
      <TweakToggle label="Placeholder check" value={t.placeholders} onChange={(v) => setTweak('placeholders', v)} />
      <TweakToggle label="Character count" value={t.showChars} onChange={(v) => setTweak('showChars', v)} />
    </TweaksPanel>
  );
}

ReactDOM.createRoot(document.getElementById('tweaks-root')).render(<TweaksApp />);
