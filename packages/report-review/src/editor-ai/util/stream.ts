/**
 * Converts an AsyncIterable to a ReadableStream
 */
export function asyncIterableToStream<T>(
  iterable: AsyncIterable<T>,
): ReadableStream<T> {
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const result of iterable) {
          controller.enqueue(result);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

// Adapted from the upstream async-iterable-stream helper (our own copy).

/**
 * A stream that is both an AsyncIterable and a ReadableStream
 */
export type AsyncIterableStream<T> = AsyncIterable<T> & ReadableStream<T>;

/**
 * Creates an AsyncIterableStream from a ReadableStream
 */
export function createAsyncIterableStream<T>(
  source: ReadableStream<T>,
): AsyncIterableStream<T> {
  if (source.locked) {
    throw new Error(
      "Stream (source) is already locked and cannot be iterated.",
    );
  }

  const stream = source.pipeThrough(new TransformStream<T, T>());

  (stream as any)[Symbol.asyncIterator] = () => {
    if (stream.locked) {
      throw new Error("Stream is already locked and cannot be iterated again.");
    }

    const reader = stream.getReader();
    return {
      async next(): Promise<IteratorResult<T>> {
        const { done, value } = await reader.read();
        return done ? { done: true, value: undefined } : { done: false, value };
      },
    };
  };

  return stream as AsyncIterableStream<T>;
}

/**
 * Creates an AsyncIterableStream from an AsyncGenerator
 */
export function createAsyncIterableStreamFromAsyncIterable<T>(
  source: AsyncIterable<T>,
): AsyncIterableStream<T> {
  return createAsyncIterableStream(asyncIterableToStream(source));
}
