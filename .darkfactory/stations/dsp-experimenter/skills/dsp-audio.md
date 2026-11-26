# dsp-audio — DSP experiment protocol

## Signal and frames
- The test signal is fixed before the experiment: type, duration in frames,
  sample rate, amplitude. Selecting the signal to fit the result is fraud.
- Measure in frames and seconds with the sample rate stated; "samples" without
  context is insufficient.

## Metrics
- Baseline set: level (peak/RMS), spectral characteristics of the target band,
  SNR/distortion where processing is claimed, chain latency in frames.
- Thresholds come from the card; if no threshold exists, record the measured
  value and mark it as an observation, not a pass.
- Every metric includes a one-line measurement method.

## Reproducibility
- Signal-generator seed/parameters belong in the recipe; an experiment without
  a recipe cannot be frozen and cannot be accepted.
- A threshold breach is a violation even "by one frame": reconsider the signal
  boundary or acknowledge the breach, but do not round it away.
