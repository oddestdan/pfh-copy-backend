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
                logger.info('Disconnecting user...');
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
                    payload: {username}
                });

            });

            socket.on('error', () => {
                return errorHandler(socket, errors.CONNECTION_ERROR)
            });

            socket.on('connect_failed', (event) => {
                return errorHandler(socket, errors.CONNECTION_FAILED)
            });

            socket.on('request-new-peer', ({ room }) => {
                logger.info('Received new peer request');
                socket.to(room).broadcast.emit('create-peer', {
                    answer: successes.NEW_PEER_REQUEST,
                    payload: {},
                });
            })

            socket.on('media-offer', ({offer, room}) => {
                logger.info('Received media offer');
                socket.to(room).broadcast.emit('media-back-offer', {
                    answer: successes.MEDIA_OFFER,
                    payload: offer,
                });
            });

            socket.on('media-answer', ({answer, room}) => {
                logger.info('Received media answer');
                socket.to(room).broadcast.emit('media-back-answer', {
                    answer: successes.MEDIA_ANSWER,
                    payload: answer,
                });
            });
        }
    )
};

