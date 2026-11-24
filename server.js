require('dotenv').config()

const express = require('express')
const axios = require('axios')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())
app.use((req, res, next) => {
    const publicRoutes = ['/login', '/callback']

    if (publicRoutes.includes(req.path)) {
        return next()
    }

    const tokens = readTokens()

    if (!tokens || !tokens.refresh_token) {
        return res.redirect('/login')
    }

    next()
})

app.use(express.static(path.join(__dirname, 'public')))

const tokenPath = path.join(__dirname, 'token.json')
let oauthState = null

const scopes = [
    'user-read-playback-state',
    'user-read-currently-playing',
    'user-modify-playback-state'
].join(' ')

// Read stored OAuth tokens
function readTokens() {
    if (!fs.existsSync(tokenPath)) return null

    return JSON.parse(fs.readFileSync(tokenPath, 'utf8'))
}

// Store OAuth tokens
function saveTokens(tokens) {
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2))
}

// Check login
function checkSpotifyLogin(req, res, next) {
    const tokens = readTokens()

    if (!tokens || !tokens.refresh_token) {
        return res.redirect('/login')
    }

    next()
}

// Login
app.get('/login', (req, res) => {
    oauthState = crypto.randomBytes(16).toString('hex')

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: process.env.CLIENT_ID,
        scope: scopes,
        redirect_uri: process.env.REDIRECT_URI,
        state: oauthState
    })

    res.redirect(`https://accounts.spotify.com/authorize?${params}`)
})

// OAuth callback
app.get('/callback', async (req, res) => {
    try {
        const { code, state, error } = req.query

        if (error) {
            return res.status(400).send(`Spotify authorization failed: ${error}`)
        }

        if (!code || !state || state !== oauthState) {
            return res.status(400).send('Invalid state or missing authorization code')
        }

        oauthState = null

        const response = await axios.post(
            process.env.SPOTIFY_TOKEN_URL,
            new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: process.env.REDIRECT_URI
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Authorization: `Basic ${Buffer.from(
                        `${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`
                    ).toString('base64')}`
                }
            }
        )

        const tokenData = {
            access_token: response.data.access_token,
            refresh_token: response.data.refresh_token,
            expires_at: Date.now() + (response.data.expires_in * 1000)
        }

        saveTokens(tokenData)

        res.send('Spotify successfully connected! You can close this page.')
    } catch (error) {
    console.error('OAuth error:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message
    })

    res.status(500).json({
        error: 'Failed to authenticate with Spotify',
        details: error.response?.data || error.message
    })
}
})

app.get('/auth/status', (req, res) => {
    try {
        const tokens = readTokens()

        if (!tokens || !tokens.refresh_token) {
            return res.json({
                logged: false,
                message: 'Spotify account not connected'
            })
        }

        res.json({
            logged: true,
            tokenValid: Date.now() < tokens.expires_at,
            message: 'Spotify account connected'
        })

    } catch (error) {
        console.error(error.message)

        res.status(500).json({
            error: 'Failed to check authentication status'
        })
    }
})

// Get a valid Spotify token
async function getSpotifyToken() {
    const storedTokens = readTokens()

    if (!storedTokens) {
        throw new Error('Spotify not connected. Visit /login first.')
    }

    // Return existing token if still valid
    if (storedTokens.access_token && Date.now() < storedTokens.expires_at - 60_000) {
        return storedTokens.access_token
    }

    // Refresh expired token
    const response = await axios.post(
        process.env.SPOTIFY_TOKEN_URL,
        new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: storedTokens.refresh_token
        }),
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: `Basic ${Buffer.from(
                    `${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`
                ).toString('base64')}`
            }
        }
    )

    const tokenData = {
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token || storedTokens.refresh_token,
        expires_at: Date.now() + (response.data.expires_in * 1000)
    }

    saveTokens(tokenData)

    console.log('Spotify token refreshed')

    return tokenData.access_token
}

// Current playback state
app.get('/playbackState', checkSpotifyLogin, async (req, res) => {
    try {
        const token = await getSpotifyToken()

        const response = await axios.get(
            `${process.env.SPOTIFY_URL}me/player`,
            {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            }
        )

        res.json(response.data)
    } catch (error) {
        console.error(error.response?.data || error.message)

        res.status(500).json({
            error: 'Failed to retrieve current Playback State'
        })
    }
})

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\nServer up and running\n\nhttp://localhost:${PORT}`)
})
