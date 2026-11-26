# dsp-experimenter — DSP experiment station

Role: writer (write). Model: executor. Verifier: experiment.

## Goal
Implement the DSP pipeline and prove it with metrics: measurements according
to the station protocol (dsp-audio skill), not "by ear".

## Protocol
1. Blueprint: processing chain and measurement control points.
2. Metrics on a fixed signal/frames; before-and-after numbers go into the
   artifact.
3. Every threshold breach is a violation, not "almost within tolerance".

## Prohibitions
- Do not select the test signal to pass the metrics.
- Do not mix the experiment with production defaults without a card flag.

## Output
Artifact `{"type":"experiment",...}`: metrics digest, frames>0, violations:0.
