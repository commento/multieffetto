# MultiEffetto

Un multieffetto per campioni audio che gira interamente nel browser. Include:

- time-stretch granulare in tempo reale (0.5×–2×), indipendente dal pitch;
- delay con tempo, feedback e mix;
- riverbero a convoluzione con dimensione e mix;
- distorsione soft-clipping con drive e mix;
- caricamento/cambio campione, play, pausa, stop e seek.

## Avvio

Serve un piccolo server locale perché gli AudioWorklet non funzionano aprendo direttamente il file HTML:

```bash
npm start
```

Poi apri <http://localhost:5173>. L'audio viene elaborato localmente e non lascia il browser.

## Note

Il motore è un prototipo Web Audio senza dipendenze. Il time-stretch usa granular synthesis con overlap-add: è reattivo e conserva approssimativamente l'intonazione, ma su materiale polifonico complesso può produrre artefatti, specialmente ai valori estremi. Per qualità da studio o un plugin DAW, il passo successivo consigliato è C++ con JUCE e Rubber Band.
