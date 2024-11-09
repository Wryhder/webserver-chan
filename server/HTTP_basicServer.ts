import * as net from "net";
import { Buffer } from "node:buffer";
import { validateHeaderName, validateHeaderValue } from "node:http";

import { HOST, PORT, kMaxHeaderLen, HTTP_VERSION } from "../data";
import { TCPConn, DynamicBuf, HTTPReq, HTTPRes, BodyReader } from "../types";

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
        conn.socket.resume();
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
                console.log("Error writing response...");
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

// Grow DynamicBuf capacity by the specified power
function expandBufferCap(buf: DynamicBuf, newLength: number, power: number): Buffer {
    const oldLength = buf.data.length;
    let cap = Math.max(oldLength, 32);  // where's the 32 coming from?

    while (cap < newLength) {
        cap *= power;
    }

    const grownBuf = Buffer.alloc(cap);
    return grownBuf;
}

// Append data to DynamicBuf
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

// Remove data from the front of the Buffer
// (i.e, move any remaining data to the front of the buffer
// after extracting a complete message)
function bufferPop(buf: DynamicBuf, length: number): void {
    buf.data.copyWithin(0, length, buf.length);
    buf.length -= length;
}

/*
------------------------------------------------------------------------------------------
Exercise 1: Implement the splitLines(), parseRequestLine(), and validateHeader() functions
based on the HTTP RFCs
(PS: I changed some function names for the exercises.)
------------------------------------------------------------------------------------------
*/

// Checks for the presence of any of "\r\n", "\r", or "\n" delimiters
function findDelimiter(buf: Buffer, start: number): [number, number] {
    let crlf = buf.indexOf("\r\n", start);
    let cr = buf.indexOf("\r", start);
    let lf = buf.indexOf("\n", start);
    let index: number, delimOffset: number;

    switch (true) {
        case crlf >= 0:
            index = crlf;
            delimOffset = 2;
            break;
        case cr >= 0:
            index = cr;
            delimOffset = 1;
            break;
        case lf >= 0:
            index = lf;
            delimOffset = 1;
            break;
        default:
            index = -1;
            delimOffset = 0;
            // console.log("No delimiter found.");
    }

    return [index, delimOffset];
}

// Splits lines on "\r\n", "\r", or "\n"
function splitLines(buf: Buffer): Buffer[] {
    let lines: Buffer[] = [];
    let start = 0;

    while (true) {
        let [next, delimOffset] = findDelimiter(buf, start);
        let chunk: Buffer;

        if (next == -1)  {       
            chunk = buf.subarray(start);

            if (chunk.toString() === "") {
                break
            }

            lines.push(chunk);
            break;
        } else {
            chunk = buf.subarray(start, next);
            lines.push(chunk)
        }

        start = next + delimOffset;
    }

    return lines;
}

// Parses the start line of a request
// Example start line: `GET /some-resource HTTP/1.1`
function parseRequestLine(reqLine: Buffer): [string, Buffer, string] {
    let parsed = reqLine.toString().split(" ");
    const [method, uri, version] = parsed;
    return [method, Buffer.from(uri), version];
}

// Checks if a header field (name and value) is valid according to
// the HTTP specification
function validateHeader(headerField: Buffer): boolean {
    // Example header field: `'content-type': 'text/html'`
    const fieldTokens: string[] = headerField.toString().split(":");
    const headerName = fieldTokens[0].trim();
    // TODO: Get header value without `.join().trim()`. It's a tempoary fix for
    // extracting values like "127.0.0.1:1234", which are split unintentionally
    // when we use `.toString().split(":")` above to get parts of the header field.
    const headerValue = fieldTokens.slice(1, fieldTokens.length).join().trim();

    try {
        validateHeaderName(headerName);
        validateHeaderValue(headerName, headerValue);
    } catch (err) {
        return false;
    }

    return true;
}

/*
-----------------------------------------END----------------------------------------------
*/

// Parse an HTTP request header
function parseHTTPReq(data: Buffer): HTTPReq {
    // Split the data into lines
    const lines: Buffer[] = splitLines(data);
    // The first line is the request line: `METHOD URI VERSION`...
    const [method, uri, version] = parseRequestLine(lines[0]);
    // ...followed by header fields in the format of `Name: value`
    const headers: Buffer[] = [];

    for (let i = 1; i < lines.length - 1; i++) {
        const headerField = Buffer.from(lines[i]);   // copy
        if (!validateHeader(headerField)) {
            throw new HTTPError(400, "Bad field.");
        }
        headers.push(headerField);
    }

    // The header ends on an empty line
    console.assert(lines[lines.length - 1].length === 0);
    return {
        method,
        uri,
        version,
        headers,
    };
}

// Parse and remove a header from the beginning of the buffer
// if possible; we wait for the full HTTP header before parsing anything
function collectMessage(buf: DynamicBuf): null | HTTPReq {
    // The end of a header is signified by "\r\n\r\n"
    const index = buf.data.subarray(0, buf.length).indexOf("\r\n\r\n");
    if (index < 0) {
        if (buf.length >= kMaxHeaderLen) {
            throw new HTTPError(413, "Header is too large.")
        }
        return null;  // need more data
    }

    // parse and remove the header
    const msg = parseHTTPReq(buf.data.subarray(0, index + 4));
    bufferPop(buf, index + 4);
    return msg;
}

/*
------------------------------------------------------------------------------------------
Exercise 2: Implement the fieldGet() function
------------------------------------------------------------------------------------------
*/

// Looks up a field value by name. Names are case-insensitive.
// TODO: `headers` should probably be a map instead of an array (`Buffer[]`)
function getField(headers: Buffer[], key: string): null | Buffer {
    for (let i = 1; i < headers.length - 1; i++) {
        const headerField = Buffer.from(headers[i]);   // copy
        let headerName = headerField.toString().split(":")[0].trim();
        let headerValue;
        
        if (key.toString().toLowerCase() === headerName.toString().toLowerCase()) {
            headerValue = headerField.toString().split(":")[1].trim();
            return Buffer.from(headerValue);
        }
    }
    return null;
}

/*
-----------------------------------------END----------------------------------------------
*/

// Returns a BodyReader from a socket of known length.
// BodyReader reads exactly the number of bytes specified in the Content-Length field.
// Also, data from the socket goes in the buffer first, then we drain data from the buffer.
// This is because (1) there may be extra data in the buffer before we read from the socket and
// (2) the last read may return more data than we need and we put the surplus data back in the buffer. 
function readerFromConnLength(
    conn: TCPConn,
    buf: DynamicBuf,
    remainingBodyLen: number // used to keep track of the remaining body length 
): BodyReader {
    return {
        length: remainingBodyLen,
        read: async (): Promise<Buffer> => {
            if (remainingBodyLen === 0) {
                return Buffer.from("");  // done
            }
            if (buf.length === 0) {
                // try to get some data if there is none
                const data = await socketRead(conn);
                bufferPush(buf, data);

                if (data.length === 0) {
                    // expect more data
                    throw new Error("Unexpected EOF from HTTP body");
                }
            }

            // Consume more data from the buffer
            const howMuchToConsume = Math.min(buf.length, remainingBodyLen);
            remainingBodyLen -= howMuchToConsume;
            const data = Buffer.from(buf.data.subarray(0, howMuchToConsume));
            bufferPop(buf, howMuchToConsume);
            return data;
        }
    };
}

// BodyReader from an HTTP request
function readerFromReq(
    conn: TCPConn,
    buf: DynamicBuf,
    req: HTTPReq
): BodyReader {
    let bodyLen = -1;
    const contentLen = getField(req.headers, "Content-Length");

    if (contentLen) {
        bodyLen = parseInt(contentLen.toString("latin1"));
        if (isNaN(bodyLen)) {
            throw new HTTPError(400, "Bad Content-Length.");
        }
    }

    const bodyAllowed = !(req.method === "GET" || req.method === "HEAD");
    const chunked = getField(
        req.headers, "Transfer-Encoding"
    )?.equals(Buffer.from("chunked")) || false;

    if (!bodyAllowed && (bodyLen > 0 || chunked)) {
        throw new HTTPError(400, "HTTP body not allowed.");
    }
    if (!bodyAllowed) bodyLen = 0
    if (bodyLen >= 0) {
        // "Content-Length" is present
        return readerFromConnLength(conn, buf, bodyLen);
    } else if (chunked) {
        // chunked encoding
        throw new HTTPError(501, "TODO:");
    } else {
        // Read the rest of the connection
        throw new HTTPError(501, "TODO:");
    }
}

// BodyReader from in-memory data
function readerFromMemory(data: Buffer): BodyReader {
    let done = false;

    return {
        length: data.length,
        // Returns the full data on the first call and an EOF after that.
        // This is useful for reponding with something small and already fits in memory (?).
        read: async (): Promise<Buffer> => {
            if (done) {
                return Buffer.from("");  // no more data
            } else {
                done = true;
                return data;
            }
        },
    };
}

// Request handler
function handleReq(req: HTTPReq, body: BodyReader): Promise<HTTPRes> {
    // Handle the request URI
    let res: BodyReader;

    switch (req.uri.toString("latin1")) {
        case "/echo":
            // HTTP echo server
            res = body;
            break;
        default:
            res = readerFromMemory(Buffer.from("hello world.\n"));
            break;
    }

    return new Promise((resolve) => {
        resolve({
            statusCode: 200,
            headers: [Buffer.from("Server: my_first_http_server")],
            body: res,
        });
    });
}

/*
------------------------------------------------------------------------------------------
Exercise 3: Implement the encodeHTTPResp() function
------------------------------------------------------------------------------------------
*/

// Encodes a response header into a byte buffer.
// (Message format is almost identical to the request message except for the first line:
// `status-line = HTTP-version SP status-code SP [ reason-phrase ]`)
function encodeHTTPRes(res: HTTPRes): Buffer {
    let delimiter = Buffer.from("\r\n");
    let statusLine = Buffer.from(`${HTTP_VERSION} ${res.statusCode}`);

    let joinedHeaderFields = (function joinBuffers(buffers: Buffer[]): Buffer {
        return buffers.reduce((prev, buf) => Buffer.concat([prev, delimiter, buf]));
    })(res.headers);

    const header = Buffer.concat([statusLine, delimiter, joinedHeaderFields]);

    return header;
}

/*
-----------------------------------------END----------------------------------------------
*/

// Send an HTTP response through the socket
async function writeHTTPRes(conn: TCPConn, res: HTTPRes): Promise<void> {
    if (res.body.length < 0) {
        throw new Error("TODO: chunked encoding");
    }

    // Set the "Content-Length field"
    console.assert(!getField(res.headers, "Content-Length"));
    res.headers.push(Buffer.from(`Content-Length: ${res.body.length}`));

    // Write the header
    console.log("Writing headers...");
    // console.log("encodeHTTPRes(res): ", encodeHTTPRes(res).toString());
    await socketWrite(conn, encodeHTTPRes(res));

    // Write the body
    while(true) {
        const data = await res.body.read();
        if (data.length === 0) break
        // console.log("Received some data: ", data.toString());
        console.log("Writing the payload...");
        await socketWrite(conn, data);
    }
}

/*
------------------------------------------------------------------------------------------
Exercise ?: Implement a custom Error type
------------------------------------------------------------------------------------------
*/

// Used to generate an error response and close the connection;
// only used to defer error handling
class HTTPError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
        this.name = this.constructor.name;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
/*
-----------------------------------------END----------------------------------------------
*/

async function serveClient(conn: TCPConn): Promise<void> {
    const buf: DynamicBuf = {
        data: Buffer.alloc(0),
        length: 0,
    };

    while (true) {
        // attempt to get one (1) request header from the buffer
        const msg: null | HTTPReq = collectMessage(buf);
        if (!msg) {
            // we need more data
            const data: Buffer = await socketRead(conn);
            bufferPush(buf, data);

            // EOF?
            if (data.length === 0 && buf.length === 0) {
                return; // no more requests
            }

            if (data.length === 0) {
                throw new HTTPError(400, "Unexpected EOF.");
            }

            // we got some data, try again
            continue;
        }

        // process the message and send the response
        const reqBody: BodyReader = readerFromReq(conn, buf, msg);
        const res: HTTPRes = await handleReq(msg, reqBody);
        await writeHTTPRes(conn, res);

        // close the connection for HTTP/1.0
        if (msg.version === "1.0") {
            return;
        }

        // ensure the request body is consumed completely
        while ((await reqBody.read()).length > 0) {/* empty */}
    } // loop for I/O
}

async function handleNewConn(socket: net.Socket): Promise<void> {
    const conn: TCPConn = socketInit(socket);

    console.log("new connection", socket.remoteAddress, socket.remotePort);

    try {
        await serveClient(conn);
    } catch (error) {
        console.error("exception:", error);

        if (error instanceof HTTPError) {
            // Intended to send an error response
            const res: HTTPRes = {
                statusCode: error.statusCode,
                headers: [],
                body: readerFromMemory(Buffer.from(error.message + "\n")),
            }

            try {
                await writeHTTPRes(conn, res);
            } catch(error) { /* ignore */ }
        }
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
server.listen({ host: HOST, port: PORT });

