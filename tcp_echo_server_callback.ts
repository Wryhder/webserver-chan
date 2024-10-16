// Access networking functionality
import * as net from "net";

function handleNewConn(socket: net.Socket): void {
    console.log("new connection", socket.remoteAddress, socket.remotePort);

    socket.on("end", () => {
        // FIN received, so connection will be auto-closed
        console.log("EOF");
    });

    socket.on("data", (data: Buffer) => {
        console.log("data", data);
        socket.write(data); // echo back received data

        // close connection if data contains a "q"
        if (data.includes("q")) {
            console.log("closing...");
            socket.end(); // send FIN and close the connection
        }
    });
}

// Create a listening socket
let server = net.createServer();

server.on("error", (err: Error) => { throw err; });
server.on("connection", handleNewConn);

server.listen({host: "127.0.0.1", port: 1234});

