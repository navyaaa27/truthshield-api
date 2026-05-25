class RekognitionClient {
  constructor(_config) {}
  send(_command) {
    return Promise.resolve({
      FaceDetails: [
        {
          BoundingBox: { Top: 0.1, Left: 0.2, Width: 0.3, Height: 0.4 },
          Confidence: 99.5,
          Landmarks: [],
          Quality: { Sharpness: 80, Brightness: 70 },
        },
      ],
    });
  }
}

class DetectFacesCommand {
  constructor(_input) {
    this.input = _input;
  }
}

module.exports = { RekognitionClient, DetectFacesCommand };
