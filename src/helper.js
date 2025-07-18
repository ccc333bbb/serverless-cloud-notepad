import jwt from '@tsndr/cloudflare-worker-jwt'
import * as TEMPL from './template'
import { SUPPORTED_LANG } from './constant'

// generate random string
export const genRandomStr = n => {
    // remove char that confuse user
    const charset = '2345679abcdefghjkmnpqrstwxyz'
    return Array(n)
        .join()
        .split(',')
        .map(() => charset.charAt(Math.floor(Math.random() * charset.length)))
        .join('')
}

export function returnPage(type, data) {
    return new Response(TEMPL[type](data), {
        headers: {
            'content-type': 'text/html;charset=UTF-8',
        },
    });
}

export function returnJSON(code, data, headers = {}) {
    const successTempl = {
        err: 0,
        msg: 'ok',
        ...data && { data },
    }
    const errTempl = {
        err: code,
        msg: JSON.stringify(data),
    }
    const ret = code ? errTempl : successTempl
    return new Response(JSON.stringify(ret), {
        headers: {
            'content-type': 'application/json;charset=UTF-8',
            ...headers,
        },
    })
}

export async function MD5(str) {
    const msgUint8 = new TextEncoder().encode(str)
    const hashBuffer = await crypto.subtle.digest('MD5', msgUint8) 
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function saltPw(password, salt) {
    const hashPw = await MD5(password)
    return await MD5(`${hashPw}+${salt}`)
}

export async function checkAuth(cookie, path, secret) {
    if (cookie && cookie.auth) {
        try {
            const valid = await jwt.verify(cookie.auth, secret)
            if (valid) {
                const { payload } = jwt.decode(cookie.auth)
                return payload && payload.path === path
            }
        } catch (error) {
            console.log(error)
        }
    }
    return false
}

export async function queryNote(key, notes) {
    const result = await notes.getWithMetadata(key)
    return {
        value: result.value || '',
        metadata: result.metadata || {},
    }
}

export function getI18n(request) {
    const DEFAULT_LANG = 'en'
    const al = request.headers.get('Accept-Language') || DEFAULT_LANG
    const acceptList = al.split(',').map(lang => lang.split(';')[0].trim())
    return acceptList.find(lang => Object.keys(SUPPORTED_LANG).includes(lang)) || DEFAULT_LANG
}
