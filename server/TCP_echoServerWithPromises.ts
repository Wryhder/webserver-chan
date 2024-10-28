// Access networking functionality
import * as net from "net";

import { HOST, PORT } from "../data";
import { TCPConn } from "../types";

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

// async function handleNewConn(socket: net.Socket): Promise<void> {
//     console.log("new connection", socket.remoteAddress, socket.remotePort);

//     try {
//         await serveClient(socket);
//     } catch (error) {
//         console.error("exception:", error);
//     } finally {
//         socket.destroy();
//     }
// }

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

// type TCPListener = {
//     socket: net.Socket;
//     // received from "error" event
//     err: null | Error;
//     // EOF, from "end" event
//     connected: boolean;
// };

// // // pseudo code!
// // while (running) {
// //     let socket = await server.accept();
// //     newConn(socket); // no `await` on this
// // }


// function socketListen(): TCPListener {};
// function socketAccept(listener: TCPListener): Promise<TCPConn> {};

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

// server.on("connection", socketAccept);

server.listen({host: HOST, port: PORT});

