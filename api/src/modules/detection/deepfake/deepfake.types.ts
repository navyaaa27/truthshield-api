export interface FaceRegion {
  boundingBox: { top: number; left: number; width: number; height: number };
  confidence: number;
  landmarks: object | null;
  faceIndex: number;
}

export interface FaceDetection {
  faceCount: number;
  faces: FaceRegion[];
  detectionConfidence: number;
}

export interface HiveClass {
  class: string;
  score: number;
}

export interface HiveAnalysisResult {
  deepfakeScore: number; // 0-1
  faceSwapScore: number; // 0-1
  ganGeneratedScore: number; // 0-1
  classes: HiveClass[];
  rawResponse: object;
}

export interface RekognitionResult {
  faceCount: number;
  faces: FaceRegion[];
  qualityScore: number;
  rawResponse: object;
}

export interface FrameAnalysis {
  frameIndex: number;
  timestampSeconds: number;
  s3Key: string;
  hiveResult: HiveAnalysisResult | null;
  rekognitionResult: RekognitionResult | null;
  frameScore: number;
}

export interface DeepfakeResult {
  score: number;
  verdict: string;
  confidence: number;
  flags: string[];
  details: {
    contentType: 'image' | 'video';
    framesAnalyzed: number;
    facesDetected: number;
    hiveAnalysis: HiveAnalysisResult | null;
    frameAnalyses: FrameAnalysis[];
    worstFrameScore: number;
    averageFrameScore: number;
    manipulationIndicators: string[];
  };
}

export interface ExtractedFrame {
  timestamp: number;
  filePath: string;
  frameIndex: number;
}
