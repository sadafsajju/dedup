//! Plain-HTTP → self-signed-HTTPS tunnel for the canvas.
//!
//! WKWebView offers no way to trust a self-signed certificate inside an
//! embedded iframe, so dev servers running @vitejs/plugin-basic-ssl (or any
//! local https) would render a blank canvas. Instead of asking users to
//! reconfigure their project, we listen on a local plain-TCP port and splice
//! every connection into a fresh TLS connection to the upstream dev server,
//! skipping certificate verification (safe: both ends are 127.0.0.1, and the
//! upstream cert is self-signed by the user's own tooling anyway).
//!
//! Byte-level splicing means HTTP, HMR websockets, and streaming all pass
//! through untouched — the canvas just sees a normal http://localhost server.

use std::net::TcpListener as StdTcpListener;
use tokio::io::copy_bidirectional;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

pub struct Tunnel {
    pub port: u16,
    /// Dropping this sender (i.e. dropping the Tunnel) stops the accept loop.
    _shutdown: oneshot::Sender<()>,
}

pub fn start(upstream_port: u16) -> Result<Tunnel, String> {
    // Bind synchronously so we know the port before returning.
    let std_listener =
        StdTcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("tunnel bind: {e}"))?;
    std_listener
        .set_nonblocking(true)
        .map_err(|e| format!("tunnel nonblocking: {e}"))?;
    let port = std_listener
        .local_addr()
        .map_err(|e| format!("tunnel addr: {e}"))?
        .port();

    let (tx, mut rx) = oneshot::channel::<()>();

    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()
        {
            Ok(rt) => rt,
            Err(_) => return,
        };
        rt.block_on(async move {
            let listener = match TcpListener::from_std(std_listener) {
                Ok(l) => l,
                Err(_) => return,
            };
            loop {
                tokio::select! {
                    // Resolves (with Err) as soon as the Tunnel is dropped.
                    _ = &mut rx => break,
                    accepted = listener.accept() => {
                        let Ok((client, _)) = accepted else { continue };
                        tokio::spawn(async move {
                            let _ = pipe(client, upstream_port).await;
                        });
                    }
                }
            }
        });
    });

    Ok(Tunnel {
        port,
        _shutdown: tx,
    })
}

async fn pipe(
    mut client: TcpStream,
    upstream_port: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    let connector = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()?;
    let connector = tokio_native_tls::TlsConnector::from(connector);
    let tcp = TcpStream::connect(("127.0.0.1", upstream_port)).await?;
    let mut upstream = connector.connect("localhost", tcp).await?;
    let _ = copy_bidirectional(&mut client, &mut upstream).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn tunnels_plain_http_to_self_signed_tls_upstream() {
        // Stand in for a basic-ssl Vite server: TLS with a self-signed cert.
        // (rustls server side — macOS SecureTransport can't import rcgen keys.)
        let _ = rustls::crypto::ring::default_provider().install_default();
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let key = rustls::pki_types::PrivateKeyDer::Pkcs8(
            cert.key_pair.serialize_der().into(),
        );
        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert.cert.der().clone()], key)
            .unwrap();
        let config = std::sync::Arc::new(config);
        let server = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_port = server.local_addr().unwrap().port();

        std::thread::spawn(move || {
            let (conn, _) = server.accept().unwrap();
            let tls_conn = rustls::ServerConnection::new(config).unwrap();
            let mut tls = rustls::StreamOwned::new(tls_conn, conn);
            let mut buf = [0u8; 1024];
            let _ = tls.read(&mut buf).unwrap();
            tls.write_all(
                b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
            )
            .unwrap();
        });

        let tunnel = start(upstream_port).unwrap();
        let mut client =
            std::net::TcpStream::connect(("127.0.0.1", tunnel.port)).unwrap();
        client
            .write_all(b"GET / HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n")
            .unwrap();
        let mut resp = String::new();
        client.read_to_string(&mut resp).unwrap();
        assert!(resp.starts_with("HTTP/1.1 200"), "unexpected response: {resp}");
        assert!(resp.ends_with("ok"));
    }
}
