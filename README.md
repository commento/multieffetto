# MultiEffetto

Un multieffetto per campioni audio che gira interamente nel browser. Include:

- time-stretch granulare in tempo reale (0.5×–2×), indipendente dal pitch;
- pitch shifter granulare da −12 a +12 semitoni, indipendente dallo stretch;
- delay con tempo, feedback e mix;
- riverbero a convoluzione con dimensione e mix;
- distorsione soft-clipping con drive e mix;
- equalizzatore a tre bande (160 Hz, 1 kHz e 6,5 kHz), ±12 dB;
- riproduzione forward/reverse, commutabile anche durante il playback;
- caricamento/cambio campione, play, pausa, stop e seek.
- visualizzazione statica della forma d'onda nella timeline;
- salti casuali tra selezioni ripetute, con cadenza e lunghezza regolabili;
- caricamento AIFF/AIFC PCM con decoder di riserva per Safari;
- salvataggio, richiamo e cancellazione dei preset nel browser.
- catena EQ/Distorsione/Delay/Riverbero riordinabile, salvata insieme al preset.

## Avvio

Serve un piccolo server locale perché gli AudioWorklet non funzionano aprendo direttamente il file HTML:

```bash
npm start
```

Poi apri <http://localhost:5173>. L'audio viene elaborato localmente e non lascia il browser.

## Note

Il motore è un prototipo Web Audio senza dipendenze. Il time-stretch usa granular synthesis con overlap-add: è reattivo e conserva approssimativamente l'intonazione, ma su materiale polifonico complesso può produrre artefatti, specialmente ai valori estremi. Per qualità da studio o un plugin DAW, il passo successivo consigliato è C++ con JUCE e Rubber Band.
