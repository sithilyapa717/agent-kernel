from roboflow_detect import boxes_to_tracks, extract_predictions


def test_extracts_workflow_boxes_and_image_size():
    raw = {
        "outputs": [
            {
                "predictions": {
                    "image": {"width": 640, "height": 480},
                    "predictions": [
                        {"x": 80, "y": 100, "width": 40, "height": 30, "confidence": 0.9, "class": "object"},
                        {"x": 400, "y": 120, "width": 50, "height": 40, "confidence": 0.8, "class": "object"},
                    ],
                }
            }
        ]
    }
    preds, w, h = extract_predictions(raw)
    assert w == 640 and h == 480
    assert len(preds) == 2
    tracks = boxes_to_tracks(preds, w, h, confidence=0.35)
    assert [t.lane for t in tracks] == ["left", "straight"]
    assert [t.track_id for t in tracks] == ["l1", "m1"]
    assert tracks[0].bbox is not None
    assert abs(tracks[0].bbox.x - 60) < 0.01


def test_stacks_same_lane_by_depth():
    preds = [
        {"x": 80, "y": 80, "width": 20, "height": 20, "confidence": 0.9},
        {"x": 90, "y": 200, "width": 20, "height": 20, "confidence": 0.9},
        {"x": 85, "y": 300, "width": 20, "height": 20, "confidence": 0.9},
    ]
    tracks = boxes_to_tracks(preds, 300, 400, confidence=0.35)
    assert [t.track_id for t in tracks] == ["l1", "l2", "l3"]
    assert tracks[0].depth > tracks[1].depth > tracks[2].depth


def test_drops_low_confidence():
    preds = [{"x": 10, "y": 10, "width": 8, "height": 8, "confidence": 0.1}]
    assert boxes_to_tracks(preds, 100, 100, confidence=0.35) == []
