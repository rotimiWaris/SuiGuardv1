const MODEL_ID = 'onnx-community/all-MiniLM-L6-v2-ONNX'
const MODEL_DIMENSIONS = 384
const WALRUS_VECTOR_DIMENSIONS = 1536

type EmbeddingTensor = { data: ArrayLike<number>; dims: number[] }
type FeatureExtractor = (text: string, options: { pooling: 'mean'; normalize: true }) => Promise<EmbeddingTensor>

let extractorPromise: Promise<FeatureExtractor> | null = null

async function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = import('@huggingface/transformers').then(async ({ pipeline }) =>
      // This repository publishes model_q4.onnx, not model_quantized.onnx.
      // q4 tells Transformers.js to request the available file.
      await pipeline('feature-extraction', MODEL_ID, { dtype: 'q4' }) as unknown as FeatureExtractor
    ).catch((error: unknown) => {
      extractorPromise = null
      throw new Error(`Could not load the local embedding model: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  return extractorPromise
}

/** Create browser-local MiniLM vectors compatible with Walrus Memory's 1536-wide index. */
export async function embedLocally(text: string): Promise<number[]> {
  const extractor = await getExtractor()
  const result = await extractor(text, { pooling: 'mean', normalize: true })
  if (result.dims[result.dims.length - 1] !== MODEL_DIMENSIONS || result.data.length !== MODEL_DIMENSIONS) {
    throw new Error(`Local embedding model returned ${result.data.length} values; expected ${MODEL_DIMENSIONS}.`)
  }

  // Padding a normalized vector with zeroes preserves cosine similarity. A
  // separate namespace prevents mixing these vectors with other model spaces.
  const vector = new Array<number>(WALRUS_VECTOR_DIMENSIONS).fill(0)
  for (let index = 0; index < MODEL_DIMENSIONS; index += 1) {
    const value = Number(result.data[index])
    if (!Number.isFinite(value)) throw new Error('Local embedding model returned an invalid value.')
    vector[index] = value
  }
  return vector
}
