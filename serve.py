#!/usr/bin/env python3
"""Local preview server for the Oryx Product Selector.  python3 serve.py"""
import http.server, os, socketserver
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__))))
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", 8731), http.server.SimpleHTTPRequestHandler) as s:
    print("Serving http://localhost:8731")
    s.serve_forever()
