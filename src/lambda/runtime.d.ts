/**
 * Types for the `awslambda` global.
 *
 * This is injected by the Lambda Node runtime — it is NOT an npm package, and
 * there is no @types package for it. Declaring it here is the standard way to
 * use response streaming from TypeScript.
 */

export interface ResponseStream {
  write(chunk: string | Uint8Array): boolean;
  end(): void;
  setContentType?(type: string): void;
}

export interface StreamMetadata {
  statusCode: number;
  headers?: Record<string, string>;
  cookies?: string[];
}

/** Lambda Function URL event, payload format 2.0. */
export interface FunctionUrlEvent {
  version: string;
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: {
    http: {
      method: string;
      path: string;
      sourceIp: string;
    };
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace awslambda {
    function streamifyResponse(
      handler: (
        event: FunctionUrlEvent,
        responseStream: ResponseStream,
        context: unknown,
      ) => Promise<void>,
    ): unknown;

    const HttpResponseStream: {
      from(stream: ResponseStream, metadata: StreamMetadata): ResponseStream;
    };
  }
}
