const log4js = require('log4js');
const logger = log4js.getLogger();
const {Room} = require('./schemas/room.schema');
const {
    roomsWhereUser,
    errorHandler,
    deleteRoom,
    deleteUserFromRoom,
    addUserToRoom,
    createRoom,
    getUsernamesInRoom,
    getUserBySocketId,
    checkForReconnection,
    findRoom
} = require('./utilits');
const {errors, successes} = require('./constants');

const peers = {}; // TODO: use Mongo
const peerSocketToRoomCode = {}; // TODO: use Mongo
const MAX_PEERS_PER_CALL = 6; // TODO: store in constants

module.exports = function (socketIO) {
    socketIO.on('connection', function (socket) {
            logger.info('Connected...');

            socket.on('create-room', async ({username, code: room}) => {
                // Check if user is already present in any other room
                const roomsWithUser = await roomsWhereUser(socket.id, username);
                if (roomsWithUser.length) {
                    // Check if user is trying to reconnect to same room
                    return checkForReconnection(socket, roomsWithUser.pop(), room);
                }

                const createdRoom = createRoom(socket, room);
                new Room(createdRoom)
                    .save()
                    .catch(error => errorHandler(socket, error.message));
            });

            socket.on('check-room', async (room) => {
                const joinRoom = await findRoom(room);
                if (!joinRoom || !joinRoom.length) {
                    return errorHandler(socket, errors.CANT_JOIN_ROOM, room)
                }
                socket.emit('room-available', {
                    answer: successes.JOIN_ROOM_AVAILABLE,
                    payload: room
                });
            });

            socket.on('new-user', async ({username, room}) => {
                // Check if user is already present in any other room
                const roomsWithUser = await roomsWhereUser(socket.id, username);
                if (roomsWithUser.length) {
                    // Check if user is trying to reconnect to same room
                    return checkForReconnection(socket, roomsWithUser.pop(), room);
                }

                const roomToJoin = await addUserToRoom(socket, room, username);
                logger.info(roomToJoin.users);

                if (!roomToJoin) {
                    return errorHandler(socket, errors.NO_SUCH_ROOM, room);
                }

                socket.join(room);
                socketIO
                    .in(room)
                    .emit('new-user-connected', {
                        answer: successes.NEW_USER_CONNECTED,
                        payload: getUsernamesInRoom(roomToJoin),
                    });
            });

            socket.on('new-chat-message', ({message, room, username}) => {
                socket.to(room).broadcast.emit('chat-message', {
                    answer: successes.NEW_CHAT_MESSAGE,
                    payload: {
                        username,
                        message,
                    },
                });
            });

            socket.on('start-game', ({room}) => {
                socketIO
                    .to(room)
                    .emit('game-started', {answer: successes.GAME_STARTED, payload: null});
            });

            socket.on('disconnect', async () => {
                logger.info(`Disconnecting user ${socket.id}`);

                // WebRTC part
                const roomCode = peerSocketToRoomCode[socket.id];
                logger.info('roomcode:', roomCode);
                logger.info(peers);
                let peersInRoom = peers[roomCode];
                if (peersInRoom) {
                    logger.info(peersInRoom);
                    peersInRoom = peersInRoom.filter(peerID => peerID !== socket.id);
                    peers[roomCode] = peersInRoom;
                    
                    // TODO: check why we receive that event only once
                    // (when there is 1-on-1 connection)
                    socket.to(peersInRoom).broadcast.emit('peer-disconnected', {
                        answer: successes.USER_DISCONNECTED,
                        payload: {id: socket.id},
                    });
                }

                // Main WS part
                const updatedRoom = await deleteUserFromRoom(socket);
                if (!updatedRoom) {
                    return errorHandler(socket, errors.CANT_DELETE_USER_ROOM);
                }

                if (updatedRoom.created_by === socket.id) {
                    return deleteRoom(socket);
                }
                
                const username = getUserBySocketId(updatedRoom, socket.id).username;
                socket.to(updatedRoom.name).broadcast.emit('user-disconnected', {
                    answer: successes.USER_DISCONNECTED,
                    payload: {username, id: socket.id}
                });

            });

            socket.on('error', () => {
                return errorHandler(socket, errors.CONNECTION_ERROR)
            });

            socket.on('connect_failed', (event) => {
                return errorHandler(socket, errors.CONNECTION_FAILED)
            });

        /*******************************************************/
        // WebRTC video-chat (mesh network, max 6 peers per call)
        
        socket.on("join-room", ({roomCode}) => {
            logger.info(`>>> ${socket.id} joining room ${roomCode}`);

            if (peers[roomCode]) {
                const length = peers[roomCode].length;
                if (length >= MAX_PEERS_PER_CALL) {
                    socket.emit("room full");
                    return;
                }
                peers[roomCode].push(socket.id);
            } else {
                peers[roomCode] = [socket.id];
            }
            peerSocketToRoomCode[socket.id] = roomCode;
            const peerIDsInThisRoom = peers[roomCode].filter(id => id !== socket.id);

            logger.info(peerIDsInThisRoom);

            socket.emit("all-peers", {
                answer: '[RTC] Sending all peers', // TODO: constant answer
                payload: {peerIDs: peerIDsInThisRoom},
            });
        });

        socket.on("send-signal", ({userToSignal, signal, callerID}) => {
            logger.info(userToSignal, '-->', callerID);

            socketIO.to(userToSignal).emit('peer-joined', {
                answer: '[RTC] Sending signal', // TODO: constant answer
                payload: {signal, callerID},
            });
        });
    
        socket.on("return-signal", ({callerID, signal}) => {
            const { id } = socket;

            logger.info(callerID, '<--', id);

            socketIO.to(callerID).emit('received-return-signal', {
                answer: '[RTC] Returning signal', // TODO: constant answer
                payload: {signal, id},
            });
        });
    });
};

