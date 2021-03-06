import path from 'path';
import express from 'express';
import WebSocket from 'ws';
import cookieParser from 'cookie-parser';
import cookie from 'cookie';
import bcrypt from 'bcrypt';

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
mongoose.connect(process.env.DB_KEY, { useUnifiedTopology: true, useNewUrlParser: true });

import { validateEmail, generateAuthToken, toLowerCaseString, getRandomColor, getJSON, validateRequest } from './utils.js';
import { User, Whitelist } from './models.js';


//////////////////////////////////////
//  EXPRESS
//////////////////////////////////////


const app = express();

app.disable('x-powered-by');
app.use(express.static('public'));
app.use(express.json());
app.use(cookieParser());


//////////////////////////////////////
//  ROUTES
//////////////////////////////////////


const authTokens = {};

const addAuthenticatedUser = (res, user) => {
    const authToken = generateAuthToken();

    authTokens[authToken] = user;
    res.cookie('AuthToken', authToken, { httpOnly: true/*, secure: true*/, sameSite: 'strict'});
}


app.use((req, res, next) => {
    const token = req.cookies['AuthToken'];
    req.user = authTokens[token];
    next();
});


app.post('/api/v1/login', async (req, res) => {

    // Check if request is valid
    const isValidRequest = validateRequest([req.body.username, req.body.password]);
    if (!isValidRequest) return res.sendStatus(400);


    // Check if user exists
    const user = await User.findOne({ $or: [
        { username: String(req.body.username) },
        { email: toLowerCaseString(req.body.email) }
    ]}, '-_id -__v');

    if (!user) return res.sendStatus(401);


    // Check if password is valid
    const isPasswordValid = bcrypt.compareSync(req.body.password, user.password);
    if (!isPasswordValid) return res.sendStatus(401);


    // Create authenticated session
    const { username, email, color, admin } = user;
    const userObj = Object.assign({ username, email, color }, admin && { admin: true });

    addAuthenticatedUser(res, userObj);
    res.send(userObj);
});


app.post('/api/v1/register', async (req, res) => {

    //Check if request is valid
    const isValidRequest = validateRequest([req.body.email, req.body.username, req.body.password]);
    if (!isValidRequest || !validateEmail(req.body.email)) return res.sendStatus(400);


    // Check if email is whitelisted
    const email = toLowerCaseString(req.body.email);
    const whitelist = await Whitelist.findOne({ email: email });
    if (!whitelist) return res.sendStatus(403);


    // Check if user already exists
    const username = req.body.username.substring(0, 32);

    const user = await User.findOne({ $or: [
        { username },
        { email }
    ]});
    if (user) return res.sendStatus(409);


    // Create user entry in database
    const password = bcrypt.hashSync(req.body.password, 12);
    const color = getRandomColor();

    new User({
        email,
        username,
        password,
        color
    }).save();


    // Create authenticated session
    const userObj = { username, color, email };
    addAuthenticatedUser(res, userObj);
    res.send(userObj);
});


app.post('/api/v1/logout', (req, res) => {
    if (!req.user) return res.sendStatus(400);

    delete authTokens[req.cookies['AuthToken']];
    res.clearCookie('AuthToken');
    res.sendStatus(200);
});


app.get('/api/v1/user', (req, res) => {
    if (req.user) res.send(req.user);
    else res.sendStatus(401);
});


app.get('/api/v1/all', (req, res) => {
    if (req.user?.admin) res.send(Object.values(authTokens));
    else res.sendStatus(403);
});


app.get('*', (req, res) => {
    res.sendFile(path.resolve('public', 'index.html'));
});


//////////////////////////////////////
//  WS
//////////////////////////////////////


const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, req) => {

    ws.send(JSON.stringify({ op: 2, d: 30000 }));

    ws.on('message', (message) => {
        const data = getJSON(message);
        if (!data) ws.end();

        switch(data.op) {
            case 1:
                if (!data.content) break;
                const { username, color, admin } = req.user;

                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN)
                        client.send(JSON.stringify({
                            op: 0,
                            d: {
                                content: data.content.trim().substring(0, 512),
                                timestamp: Date.now(),
                                author: Object.assign({ username, color }, admin && { admin: true })
                            }
                        }));
                });
                break;

            case 3:
                ws.send(JSON.stringify({ op: 4 }));

            default:
                break;
        }
    });
});


//////////////////////////////////////
//  MAIN
//////////////////////////////////////


const server = app.listen(3040, () => {
    console.log('Server started.');
});

server.on('upgrade', (req, socket, head) => {
    if (!req.headers.cookie) return res.sendStatus(401);

    const cookies = cookie.parse(req.headers.cookie);
    const user = authTokens[cookies.AuthToken];
    if (user) {
        req.user = user;

        wss.handleUpgrade(req, socket, head, socket => {
            wss.emit('connection', socket, req);
        });
    }

    else socket.end();
});
