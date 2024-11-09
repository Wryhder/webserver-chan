import * as net from "net";

// A promise-based API for TCP sockets
export type TCPConn = {
    // JS socket object
    socket: net.Socket;
    // received from "error" event
    err: null | Error;
    // EOF, from "end" event
    ended: boolean;
    // the callbacks for the current read's promise
    reader: null | {
        resolve: (value: Buffer) => void,
        reject: (reason: Error) => void,
    };
};

// A dynamic-sized buffer
export type DynamicBuf = {
    data: Buffer,
    length: number,
};

// A parsed HTTP request header
export type HTTPReq = {
    method: string,
    /* 
    We use `Buffer` instead of `string` for the URI and header fields
    as there's no guarantee the fields will be ASCII or UTF-8 strings.
    So, we'll leave them as bytes until they're parsed. 
    */
    uri: Buffer,
    version: string,
    headers: Buffer[],
};

// A HTTP response
export type HTTPRes = {
    statusCode: number,
    headers: Buffer[],
    body: BodyReader,
};

// An interface for reading or writing data to or from the HTTP body (payload)
export type BodyReader = {
    // The "Content-Length", -1 if unknown
    length: number,
    /*
    Read data, returns an empty buffer after EOF.
    We use a read() function instead of a simple buffer because
    the payload may be arbitrarily long, not even fitting in memory.
    */
    read: () => Promise<Buffer>,
};