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