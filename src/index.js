import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import { Router } from 'itty-router'
import Cookies from 'cookie'
import jwt from '@tsndr/cloudflare-worker-jwt'
import { queryNote, MD5, checkAuth, genRandomStr, returnPage, returnJSON, saltPw, getI18n } from './helper'

dayjs.extend(utc)
dayjs.extend(timezone)

let NOTES, SHARE, SECRET, SALT

// init
const router = Router()

router.get('/', ({ url }) => {
    const newHash = genRandomStr(3)
    // redirect to new page
    return Response.redirect(`${url}${newHash}`, 302)
})

// Purge Page
const renderPurgePage = (message = '', hashKey = '', dateStr = '') => {
    const fullKey = dateStr && hashKey ? `${dateStr}${hashKey}` : '';
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Purge All Notes</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; text-align: center; }
            .container { max-width: 400px; margin: 0 auto; }
            .message { padding: 10px; margin-bottom: 15px; border-radius: 5px; }
            .message.success { background-color: #d4edda; color: #155724; }
            .message.error { background-color: #f8d7da; color: #721c24; }
            input { width: 100%; padding: 8px; margin-bottom: 10px; box-sizing: border-box; }
            button { padding: 10px 15px; cursor: pointer; }
            .purge-key-hint { margin-bottom: 10px; font-size: 16px; color: #333; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Purge All Notes</h1>
            ${message}
            <div class="purge-key-hint">Key: <b>${fullKey}</b></div>
            <form method="POST" action="/purge">
                <input type="text" id="purgeKey" name="purgeKey" placeholder="Enter purge key" required>
                <button type="submit">Purge</button>
            </form>
          </div>
        </body>
      </html>`
    return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } })
}

router.get('/purge', async () => {
    // 生成 hashkey 並存儲於 KV，5 分鐘有效
    const now = dayjs().utc().add(8, 'hour')
    const dateStr = now.format('YYYYMMDD')
    const hashKey = genRandomStr(8)
    await NOTES.put('PURGE_HASHKEY', hashKey, { expirationTtl: 300 })
    return renderPurgePage('', hashKey, dateStr)
})

router.get('/purge-debug', () => {
    const now = dayjs()
    const utcKey = now.utc().format('YYYYMMDDHHMM')
    const localKey = now.format('YYYYMMDDHHMM')
    
    // Manual GMT+8 calculation
    const utcTime = now.utc()
    const gmt8Time = utcTime.add(8, 'hour')
    const gmt8Key = gmt8Time.format('YYYYMMDDHHMM')
    
    const shanghaiKey = now.tz('Asia/Shanghai').format('YYYYMMDDHHMM')
    
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Purge Debug</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; }
            .key { font-family: monospace; font-size: 18px; padding: 10px; background: #f0f0f0; margin: 5px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Purge Key Debug</h1>
            <p><strong>UTC Key:</strong> <span class="key">${utcKey}</span></p>
            <p><strong>Local Key:</strong> <span class="key">${localKey}</span></p>
            <p><strong>GMT+8 Key (Manual):</strong> <span class="key">${gmt8Key}</span></p>
            <p><strong>Shanghai Key (Plugin):</strong> <span class="key">${shanghaiKey}</span></p>
            <p><strong>Current UTC Time:</strong> ${now.utc().format('YYYY-MM-DD HH:mm:ss')}</p>
            <p><strong>Current Local Time:</strong> ${now.format('YYYY-MM-DD HH:mm:ss')}</p>
            <p><strong>Current Shanghai Time:</strong> ${now.tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss')}</p>
            <hr>
            <p><a href="/purge">Go to Purge Page</a></p>
          </div>
        </body>
      </html>`
    
    return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } })
})

router.post('/purge', async (request) => {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown'
    const lockKey = `PURGE_LOCK_${ip}`
    const failKey = `PURGE_FAIL_COUNT_${ip}`

    // 1. Check if locked
    const isLocked = await NOTES.get(lockKey)
    if (isLocked) {
        return renderPurgePage('<div class="message error">Too many failed attempts. Please try again in 15 minutes.</div>')
    }

    // 2. Validate hashkey
    const formData = await request.formData()
    const userInput = formData.get('purgeKey') || ''
    const hashKey = await NOTES.get('PURGE_HASHKEY')
    if (!hashKey || !userInput.endsWith(hashKey)) {
        const failCount = parseInt(await NOTES.get(failKey) || '0') + 1
        if (failCount >= 3) {
            await NOTES.put(lockKey, 'locked', { expirationTtl: 900 }) // Lock for 15 mins
            await NOTES.delete(failKey)
        } else {
            await NOTES.put(failKey, failCount.toString(), { expirationTtl: 900 })
        }
        // 重新顯示 key
        const now = dayjs().utc().add(8, 'hour')
        const dateStr = now.format('YYYYMMDD')
        return renderPurgePage('<div class="message error">Invalid purge key.</div>', hashKey, dateStr)
    }
    // 驗證通過後刪除 hashkey
    await NOTES.delete('PURGE_HASHKEY')
    await NOTES.delete(failKey)

    let markedCount = 0
    let cursor = undefined
    try {
        do {
            const listResult = await NOTES.list({ cursor })
            const markPromises = []
            for (const key of listResult.keys) {
                if (key.name.startsWith('PURGE_')) {
                    continue
                }
                const { value, metadata } = await queryNote(key.name, NOTES)
                if (!metadata.marked_for_deletion) {
                    markPromises.push(
                        NOTES.put(key.name, value, {
                            metadata: {
                                ...metadata,
                                marked_for_deletion: true,
                            },
                        })
                    )
                    markedCount++
                }
            }
            await Promise.all(markPromises)
            cursor = listResult.list_complete ? undefined : listResult.cursor
        } while (cursor)
    } catch (err) {
        console.error('Purge marking failed:', err)
        return renderPurgePage(`<div class="message error">An error occurred while marking notes for deletion. Details: ${err.message}</div>`, '', '')
    }
    return renderPurgePage(`<div class="message success">Purge process initiated. ${markedCount} notes have been marked for deletion and will be removed shortly.</div>`, '', '')
})


// 处理 /list 路由
router.get('/list', async () => {
    const keys = await NOTES.list() // 获取所有笔记的键

    // 生成表格行，每行显示每个键的所有字段信息
    const rows = keys.keys.map(key => `
      <tr>
        <td><a href="/${key.name}">${key.name}</a></td>
        <td>${key.metadata ? (() => {
            const date = new Date(key.metadata.updateAt * 1000);
            const pad = num => num.toString().padStart(2, '0');
            return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
        })() : 'N/A'}
        </td>
      </tr>
    `).join('<br>')

    // 生成包含表格的HTML
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Note List</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; }
            table { width: 100%; border-collapse: collapse; }
            th, td { padding: 10px; border: 1px solid #ddd; text-align: left; }
            th { background-color: #f4f4f4; }
          </style>
        </head>
        <body>
          <h1>Note List</h1>
          <table>
            <thead>
              <tr>
                <th>Note Link</th>
                <th>Modify Time</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </body>
      </html>`

    return new Response(html, {
        headers: { 'Content-Type': 'text/html' },
    })
})

router.get('/share/:md5', async (request) => {
    const lang = getI18n(request)
    const { md5 } = request.params
    const path = await SHARE.get(md5)

    if (!!path) {
        const { value, metadata } = await queryNote(path, NOTES)

        return returnPage('Share', {
            lang,
            title: decodeURIComponent(path),
            content: value,
            ext: metadata,
        })
    }

    return returnPage('Page404', { lang, title: '404' })
})

router.get('/:path', async (request) => {
    const lang = getI18n(request)

    const { path } = request.params
    const title = decodeURIComponent(path)

    const cookie = Cookies.parse(request.headers.get('Cookie') || '')

    const { value, metadata } = await queryNote(path, NOTES)

    if (!metadata.pw) {
        return returnPage('Edit', {
            lang,
            title,
            content: value,
            ext: metadata,
        })
    }

    const valid = await checkAuth(cookie, path, SECRET)
    if (valid) {
        return returnPage('Edit', {
            lang,
            title,
            content: value,
            ext: metadata,
        })
    }

    return returnPage('NeedPasswd', { lang, title })
})

router.post('/:path/auth', async request => {
    const { path } = request.params
    if (request.headers.get('Content-Type') === 'application/json') {
        const { passwd } = await request.json()

        const { metadata } = await queryNote(path, NOTES)

        if (metadata.pw) {
            const storePw = await saltPw(passwd, SALT)

            if (metadata.pw === storePw) {
                const token = await jwt.sign({ path }, SECRET)
                return returnJSON(0, {
                    refresh: true,
                }, {
                    'Set-Cookie': Cookies.serialize('auth', token, {
                        path: `/${path}`,
                        expires: dayjs().add(7, 'day').toDate(),
                        httpOnly: true,
                    })
                })
            }
        }
    }

    return returnJSON(10002, 'Password auth failed!')
})

router.post('/:path/pw', async request => {
    const { path } = request.params
    if (request.headers.get('Content-Type') === 'application/json') {
        const cookie = Cookies.parse(request.headers.get('Cookie') || '')
        const { passwd } = await request.json()

        const { value, metadata } = await queryNote(path, NOTES)
        const valid = await checkAuth(cookie, path, SECRET)

        if (!metadata.pw || valid) {
            const pw = passwd ? await saltPw(passwd, SALT) : undefined
            try {
                await NOTES.put(path, value, {
                    metadata: {
                        ...metadata,
                        pw,
                    },
                })

                return returnJSON(0, null, {
                    'Set-Cookie': Cookies.serialize('auth', '', {
                        path: `/${path}`,
                        expires: dayjs().subtract(100, 'day').toDate(),
                        httpOnly: true,
                    })
                })
            } catch (error) {
                console.error(error)
            }
        }

        return returnJSON(10003, 'Password setting failed!')
    }
})

router.post('/:path/setting', async request => {
    const { path } = request.params
    if (request.headers.get('Content-Type') === 'application/json') {
        const cookie = Cookies.parse(request.headers.get('Cookie') || '')
        const { mode, share } = await request.json()

        const { value, metadata } = await queryNote(path, NOTES)
        const valid = await checkAuth(cookie, path, SECRET)

        if (!metadata.pw || valid) {
            try {
                await NOTES.put(path, value, {
                    metadata: {
                        ...metadata,
                        ...mode !== undefined && { mode },
                        ...share !== undefined && { share },
                    },
                })

                const md5 = await MD5(path)
                if (share) {
                    await SHARE.put(md5, path)
                    return returnJSON(0, md5)
                }
                if (share === false) {
                    await SHARE.delete(md5)
                }


                return returnJSON(0)
            } catch (error) {
                console.error(error)
            }
        }

        return returnJSON(10004, 'Update Setting failed!')
    }
})

router.post('/:path', async request => {
    const { path } = request.params
    const { value, metadata } = await queryNote(path, NOTES)

    const cookie = Cookies.parse(request.headers.get('Cookie') || '')
    const valid = await checkAuth(cookie, path, SECRET)

    if (!metadata.pw || valid) {
        // OK
    } else {
        return returnJSON(10002, 'Password auth failed! Try refreshing this page if you had just set a password.')
    }

    const formData = await request.formData();
    const content = formData.get('t')

    try {

        if (content?.trim()){
            // 有值修改
            await NOTES.put(path, content, {
                metadata: {
                    ...metadata,
                    updateAt: dayjs().unix(),
                },
            })
        }else{
            // 无值删除
            await NOTES.delete(path)
        }

        return returnJSON(0)
    } catch (error) {
        console.error(error)
    }

    return returnJSON(10001, 'KV insert fail!')
})

router.all('*', (request) => {
    const lang = getI18n(request)
    returnPage('Page404', { lang, title: '404' })
})

export default {
    async fetch(request, env, ctx) {
        // bind env
        NOTES = env.NOTES
        SHARE = env.SHARE
        SECRET = env.SCN_SECRET
        SALT = env.SCN_SALT

        return router.handle(request)
    },
    async scheduled(event, env, ctx) {
        // bind env
        NOTES = env.NOTES
        SHARE = env.SHARE
        SECRET = env.SCN_SECRET
        SALT = env.SCN_SALT
        console.log(`Cron[${event.cron}] triggered: Starting deletion sweep.`)

        let deletedCount = 0
        let cursor = undefined
        try {
            do {
                const listResult = await NOTES.list({ limit: 100, cursor })
                const keysToDelete = listResult.keys
                    .filter(key => key.metadata?.marked_for_deletion)
                    .map(key => key.name)

                if (keysToDelete.length > 0) {
                    // Cloudflare KV does not support batch delete, must delete one by one
                    const deletePromises = keysToDelete.map(keyName => NOTES.delete(keyName))
                    await Promise.all(deletePromises)
                    deletedCount += keysToDelete.length
                }

                cursor = listResult.list_complete ? undefined : listResult.cursor
            } while (cursor)
            console.log(`Deletion sweep completed. ${deletedCount} notes deleted.`)
        } catch (err) {
            console.error('Scheduled deletion failed:', err)
        }
    }
}
