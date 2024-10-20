// Access networking functionality
import * as net from "net";

// A promise-based API for TCP sockets
type TCPConn = {
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

// Create a wrapper for net.Socket
function socketInit(socket: net.Socket): TCPConn {
    const conn: TCPConn = {
        socket: socket,
        err: null,
        ended: false,
        reader: null,
    };

    socket.on("data", (data: Buffer) => {
        console.log("data", data);
        socket.write(data); // echo back received data

        // close connection if data contains a "q"
        if (data.includes("q")) {
            console.log("closing...");
            socket.end(); // send FIN and close the connection
        }
    });

    socket.on("end", () => {
        // will also fulfill the current read
        conn.ended = true;

        if (conn.reader) {
            conn.reader.resolve(Buffer.from(""));  // EOF
            conn.reader = null;

            // FIN received, so connection will be auto-closed
            console.log("EOF");
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

// echo server
async function serveClient(socket: net.Socket): Promise<void> {
    const conn: TCPConn = socketInit(socket);

    while(true) {
        const data = await socketRead(conn);

        if (data.length === 0) {  // EOF
            console.log("end connection");
            break;
        }

        console.log("data", data);
        await socketWrite(conn, data);
    }
}

// Create a listening socket
let server = net.createServer();

server.on("error", (err: Error) => { throw err; });
server.on("connection", handleNewConn);

server.listen({host: "127.0.0.1", port: 1234});

