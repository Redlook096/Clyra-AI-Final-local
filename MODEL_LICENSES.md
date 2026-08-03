# Clyra model-weight licence gate

Source-code licences do not grant rights to every model checkpoint mentioned
by a project. Clyra downloads no RTMW, RTMPose, BoT-SORT ReID, YOLO, or
MediaPipe model automatically during normal clip rendering.

| Component | Intended role | Release status | Required gate before use |
| --- | --- | --- | --- |
| MediaPipe Face Landmarker task | Face landmarks | Existing optional local model | Pin checksum and verify the task-model terms from its distribution page. |
| MediaPipe Pose Landmarker task | Lightweight body fallback | Existing optional local model | Pin checksum and verify the task-model terms from its distribution page. |
| RTMW-l / RTMW-x ONNX | Quality whole-body landmarks | Disabled | Pin exact upstream file, model card, training-data and commercial-use terms. |
| BoT-SORT ReID checkpoint | Identity re-identification | Disabled | Pin exact weights and commercial-use licence; do not inherit the MIT code licence. |
| ByteTrack detector checkpoint | Low-power identity tracking | Disabled | Pin exact detector/re-identification weights and commercial-use licence. |

The active 8 GB local worker uses only Clyra-owned trajectory logic plus the
optional MediaPipe/OpenCV packages already declared in `requirements.txt`.
If any gate fails, Clyra keeps its deterministic local association tracker and
does not claim that the unavailable model is active.
