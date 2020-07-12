import url from 'url'
import http from 'http'
import ConnectionsManagerServer from '../wrtc/connectionsManager'
import SetCORS from './setCors'
import ParseBody from './parseBody'
import { CorsOptions } from '@geckos.io/common/lib/types'

const end = (res: http.ServerResponse, statusCode: number) => {
  res.writeHead(statusCode)
  res.end()
}

const HttpServer = (server: http.Server, connectionsManager: ConnectionsManagerServer, cors: CorsOptions) => {
  const prefix = '.wrtc'
  const version = 'v1'
  const root = `/${prefix}/${version}`
  const rootRegEx = new RegExp(`/${prefix}/${version}`)

  const evs = server.listeners('request').slice(0)
  server.removeAllListeners('request')

  server.on('request', async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const pathname = req.url ? url.parse(req.url, true).pathname : undefined
    const headers = req.headers
    const method = req.method

    // if the request is not part of the rootRegEx,
    // trigger the other server's (Express) events.
    if (!pathname || !rootRegEx.test(pathname)) {
      for (var i = 0; i < evs.length; i++) {
        evs[i].call(server, req, res)
      }
    }

    if (pathname && rootRegEx.test(pathname)) {
      const path1 = pathname === `${root}/connections`
      const path2 = new RegExp(`${prefix}\/${version}\/connections\/[0-9a-zA-Z]+\/remote-description`).test(pathname)
      const path3 = new RegExp(`${prefix}\/${version}\/connections\/[0-9a-zA-Z]+\/additional-candidates`).test(pathname)
      const closePath = new RegExp(`${prefix}\/${version}\/connections\/[0-9a-zA-Z]+\/close`).test(pathname)

      SetCORS(req, res, cors)

      if (req.method === 'OPTIONS') {
        end(res, 200)
        return
      }

      let body = ''

      try {
        body = (await ParseBody(req)) as string
      } catch (error) {
        end(res, 400)
        return
      }

      res.on('error', _error => {
        end(res, 500)
        return
      })

      res.setHeader('Content-Type', 'application/json')

      if (pathname && method) {
        if (method === 'POST' && path1) {
          try {
            // create connection (and check auth header)
            const { status, connection, userData } = await connectionsManager.createConnection(headers?.authorization)

            // on http status code
            if (status !== 200) {
              if (status >= 100 && status < 600) end(res, status)
              else end(res, 500)
              return
            }

            if (!connection) {
              end(res, 500)
              return
            }

            // create the offer
            await connection.doOffer()

            const {
              id,
              iceConnectionState,
              peerConnection,
              remoteDescription,
              localDescription,
              signalingState
            } = connection

            res.write(
              JSON.stringify({
                userData, // the userData for authentication
                id,
                iceConnectionState,
                peerConnection,
                remoteDescription,
                localDescription,
                signalingState
              })
            )

            res.end()
            return
          } catch (error) {
            end(res, 500)
            return
          }
        } else if (method === 'POST' && path2) {
          const ids = pathname.match(/[0-9a-zA-Z]{24}/g)
          if (ids && ids.length === 1) {
            const id = ids[0]
            const connection = connectionsManager.getConnection(id)

            if (!connection) {
              end(res, 404)
              return
            }

            try {
              await connection.applyAnswer(JSON.parse(body))
              let connectionJSON = connection.toJSON()
              res.write(JSON.stringify(connectionJSON.remoteDescription))
              res.end()
              return
            } catch (error) {
              end(res, 400)
              return
            }
          }
        } else if (method === 'GET' && path3) {
          const ids = pathname.match(/[0-9a-zA-Z]{24}/g)
          if (ids && ids.length === 1) {
            const id = ids[0]

            if (!connectionsManager.getConnection(id)) {
              end(res, 404)
              return
            }

            let attempts = 0
            const max_attempts = 40

            const wait = () => {
              return new Promise(resolve => {
                setTimeout(() => {
                  resolve()
                }, 250)
              })
            }

            let additionalCandidates: RTCIceCandidate[] = []

            const checkNewCandidates = () => {
              const connection = connectionsManager.getConnection(id)
              if (connection) {
                additionalCandidates = [...additionalCandidates, ...connection.additionalCandidates]
                connection.additionalCandidates = []
              }
            }

            try {
              while (additionalCandidates.length === 0 && attempts < max_attempts) {
                await wait()
                attempts++
                checkNewCandidates()
                // console.log('checkNewCandidates()', attempts, additionalCandidates.length)
              }

              res.write(JSON.stringify(additionalCandidates))
              res.end()
              return
            } catch (error) {
              end(res, 400)
              return
            }
          }
        } else if (method === 'POST' && closePath) {
          const ids = pathname.match(/[0-9a-zA-Z]{24}/g)
          if (ids && ids.length === 1) {
            const id = ids[0]
            const connection = connectionsManager.getConnection(id)
            connection?.close()
          }
          res.end()
          return
        } else {
          end(res, 404)
          return
        }
      }
    }
  })
}

export default HttpServer
