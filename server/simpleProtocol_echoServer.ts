import * as net from "net";
import { Buffer } from "node:buffer";

import { HOST, PORT } from "../data";
import { TCPConn, DynamicBuf } from "../types";

// Create a wrapper for net.Socket
function socketInit(socket: net.Socket): TCPConn {
    const conn: TCPConn = {
        socket: socket,
        err: null,
        ended: false,
        reader: null,
    };

    socket.on("data", (data: Buffer) => {
        console.log("Received data: ", data);

        console.assert(conn.reader);
        // pause the "data" event until the next read
        conn.socket.pause();
        // fulfill the promise of the current read
        conn.reader!.resolve(data);
        conn.reader = null;
    });

    socket.on("end", () => {
        // will also fulfill the current read
        conn.ended = true;

        if (conn.reader) {
            conn.reader.resolve(Buffer.from(""));  // EOF
            conn.reader = null;
        }
    });

    socket.on("error", (err: Error) => {
        // errors are also delivered to the current read
        conn.err = err;

        if (conn.reader) {
            conn.reader.reject(err);
            conn.reader = null;
        }
    });

    return conn;
}

// Returns an empty `Buffer` after EOF
function socketRead(conn: TCPConn): Promise<Buffer> {
    console.assert(!conn.reader);  // no concurrent calls

    return new Promise((resolve, reject) => {
        // if the connection is not readable, complete the promise now
        if (conn.err) {
            reject(conn.err);
            return;
        }

        if (conn.ended) {
            resolve(Buffer.from(""));  // EOF
            return;
        }

        // save the promise callbacks...
        conn.reader = {
            resolve,
            reject
        };
        // ...and resume the "data" event to fulfill the promise later
        conn.socket.resume() ;
    });
}

function socketWrite(conn: TCPConn, data: Buffer): Promise<void> {
    console.assert(data.length > 0);

    return new Promise((resolve, reject) => {
        if (conn.err) {
            reject(conn.err);
            return;
        }

        conn.socket.write(data, (err?: Error) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

// grow DynamicBuf capacity by the specified power
function expandBufferCap(buf: DynamicBuf, newLength: number, power: number): Buffer {
    const oldLength = buf.data.length;
    let cap = Math.max(oldLength, 32);  // where's the 32 coming from?

    while (cap < newLength) {
        cap *= power;
    }

    const grownBuf = Buffer.alloc(cap);
    return grownBuf;
}

// append data to DynamicBuf
function bufferPush(buf: DynamicBuf, data: Buffer): void {
    const newLength = buf.length + data.length;
    if (buf.data.length < newLength) {
        // grow the capacity by a power of 2
        const grownBuf = expandBufferCap(buf, newLength, 2);
        // copy data to grown Buffer
        buf.data.copy(grownBuf, 0, 0);
        buf.data = grownBuf;
    }

    data.copy(buf.data, buf.length, 0);
    buf.length = newLength;
}

// remove data from the front of the Buffer (?)
function bufferPop(buf: DynamicBuf, length: number): void {
    buf.data.copyWithin(0, length, buf.length);
    buf.length -= length;
}

// Checks for a complete message in the buffer
function collectMessage(buf: DynamicBuf): null | Buffer {
    // messages are separated by "\n"
    const index = buf.data.subarray(0, buf.length).indexOf("\n");
    if (index < 0) {
        return null;  // not complete
    }

    // make a copy of the message
    // and move the remaining data to the front
    const msg = Buffer.from(buf.data.subarray(0, index + 1));
    bufferPop(buf, index + 1);
    return msg;
}

async function processMessage(msg: Buffer, socket: net.Socket, conn: TCPConn) {
    if (msg.equals(Buffer.from("quit\n"))) {
        await socketWrite(conn, Buffer.from("\n"));
        socket.destroy();
        return;
    } else {
        const reply = Buffer.concat([Buffer.from("Echo: "), msg]);
        await socketWrite(conn, reply);
    }
}

// echo server
async function serveClient(socket: net.Socket): Promise<void> {
    const conn: TCPConn = socketInit(socket);
    const buf: DynamicBuf = {
        data: Buffer.alloc(0),
        length: 0,
    };
    
    while(true) {
        // attempt to get one (1) message from the buffer
        const msg: null | Buffer = collectMessage(buf);
        if (!msg) {
            // we need more data
            const data: Buffer = await socketRead(conn);
            bufferPush(buf, data);

            if (data.length === 0) {  // EOF?
                console.log("end connection");
                return;
            }

            // we got some data, try again
            continue;
        }

        // process the message and send the response
        await processMessage(msg, socket, conn);
    }
}

async function handleNewConn(socket: net.Socket): Promise<void> {
    console.log("new connection", socket.remoteAddress, socket.remotePort);

    try {
        await serveClient(socket);
    } catch (error) {
        console.error("exception:", error);
    } finally {
        socket.destroy();
    }
}

// Create a listening socket
let server = net.createServer({
    pauseOnConnect: true,  // required by `TCPConn`
});

// retry if another server is listening on the requested address
server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
        console.error('Address in use, retrying...');
        setTimeout(() => {
            server.close();
            server.listen(PORT, HOST);
        }, 1000);
    } else {
        throw err;
    }
});

server.on("connection", handleNewConn);
server.listen({host: HOST, port: PORT});

