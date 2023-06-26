import {ethers} from 'ethers'
import { arrayify, computeAddress, hashMessage, recoverPublicKey } from 'ethers/lib/utils'
import jwt_decode from "jwt-decode";
import { Centrifuge } from 'centrifuge';
import axios from 'axios'
import WebSocket from 'ws';
import EventEmitter from 'events';
import dotenv from 'dotenv';

dotenv.config();

const baseApiUrl = 'https://api.fuse.io/'
const apiKey = process.env.PUBLIC_API_KEY;
const privateKey = process.env.PRIVATE_KEY
const eventEmitter = new EventEmitter();

let socketClient: any;
let smartWallet: any;

module.exports.init = async function () {
    const authDto = await getHashSigWallet();
    console.log(authDto);

    const jwt = await auth(authDto);
    console.log(jwt);

    // First we try to fetch smart wallet that belongs to the ownerAddress in the jwt
    // If the fetchSmartWallet throws, we try to create a new smart wallet
    try {
        smartWallet = await fetchSmartWallet();
        console.log('Smart Wallet successfully fetched');
        console.log(`Smart Wallet: ${JSON.stringify(smartWallet)}`);
    } catch (e) {
        eventEmitter.on('smartWalletCreated', (smartWallet) => {
            smartWallet = smartWallet;
            console.log('Smart Wallet successfully created');
            console.log(`Smart Wallet: ${JSON.stringify(smartWallet)}`);
        })

        eventEmitter.on('smartWalletCreationFailed', () => {
            console.log('Smart Wallet creation failed');
        })

        await createSmartWallet();
    }
}

const api = axios.create({
    baseURL: baseApiUrl,
    headers: {
        "Content-Type": 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': '*/*'
    }

})

/**
 * Function for creating the necessary parameters for the authentication with the smart wallets API
 * The function generates a signature and a hash based on the private key declared globally in this script
 * @param authDto 
 * @returns 
 */
async function getHashSigWallet() {
    let wallet = new ethers.Wallet(privateKey);

    const ethAddress = await wallet.getAddress()
    console.log(wallet.address);
    console.log(ethAddress);

    // let flatSig = await wallet.signMessage(ethAddress);
    const hash = await ethers.utils.keccak256(ethAddress)
    console.log(`hash: ${hash}`);
    
    const signature = await wallet.signMessage(ethers.utils.arrayify(hash))
    console.log(`signature: ${signature}`);

    // Now you have the digest,
    let publicKey = recoverPublicKey(arrayify(hashMessage(arrayify(hash))), signature);

    const recoveredAddress = computeAddress(publicKey)
    console.log(`recoveredAddress: ${recoveredAddress}`);
    
    return {hash, signature, ownerAddress: recoveredAddress}
}


/**
 * Helper function that initiates the websocket conneciton with the server. 
 * JWT from the authentication result is required.
 * @param jwt 
 * @returns 
 */
async function initWebsocket(jwt): Promise<void> {
    try {
        const data: any = jwt_decode(jwt);
        socketClient = await new Centrifuge(
            'wss://ws.chargeweb3.com/connection/websocket',
            {
                websocket: WebSocket,
                token: jwt,
                name: data.sub
            }
        );
        console.log('Connecting to websocket server');
        await socketClient.connect();
        console.log('Successfully connected to websocket server');
        await socketClient.ready()
    } catch (e) {
        throw new Error(`Centrifuge error:${e}`);
    }
}

/**
 * Function to authenticate with the smart wallets API
 * The API requires authDto in the request body in the format: {signature, hash, ownerAddress}
 * @param authDto 
 * @returns 
 */
async function auth(authDto: any) {
    try {
        api.interceptors.request.use((config) => {
            config.params = { apiKey: apiKey }
            return config
        })

        const result = await api.post(
            `api/v1/smart-wallets/auth`,
            authDto
        )
        const jwt = result.data.jwt
        api.interceptors.request.use(function (config) {
            config.headers.Authorization = `Bearer ${result.data.jwt}`
            return config
        })

        await initWebsocket(jwt)
        return jwt

    } catch (error) {
        throw new Error(`Auth error:${error}`)
    }
}

/**
 * Fetches smart wallet based on the ownerAddress embedded in the JWT in the request headers
 * API returns error if a smart wallet is not found based on the ownerAddress
 * @returns 
 */
async function fetchSmartWallet(): Promise<any> {
    try {
        const wallet = await api.get(`api/v1/smart-wallets`)
        smartWallet = wallet.data
        return smartWallet
    } catch (error) {
        throw new Error(`Fetch Wallet Error:${error}`)
    }
}

/**
 * Creates a new smart wallet based for the ownerAddress embedded in the JWT in the request
 * The smart wallet creation process is asynchronous and therefore we need to listen to events from the websocket server
 * in order to track its progress
 * @returns 
 */
async function createSmartWallet(): Promise<object> {
    try {
        const result = await api.post(
            `${baseApiUrl}api/v1/smart-wallets/create`
        )
        const connectionUrl = result.data.connectionUrl
        const transactionId = result.data.transactionId
        const subscription = socketClient.newSubscription(`transaction:#${transactionId}`)

        let smartWallet;

        subscription.on('publication', ctx => {
            console.log(ctx.data.eventName, ctx.data.eventData)
            if (ctx.data.eventName === 'smartWalletCreationSucceeded') {
                smartWallet = ctx.data.eventData
                eventEmitter.emit('smartWalletCreated', smartWallet);
            } else if (ctx.data.eventName === 'smartWalletCreationFailed') {
                eventEmitter.emit('smartWalletCreationFailed')
            }
        })

        return {
            'connectionUrl': connectionUrl,
            'transactionId': transactionId
        }

    } catch (error) {
        throw new Error(`Create Wallet Error:${JSON.stringify(error)}`)
    }
}