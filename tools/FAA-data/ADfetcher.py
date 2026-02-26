import urllib.request
import urllib.parse
import json
import os
import subprocess
import threading
import tempfile
import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext

def fetch_ad_pdf(ad_number, pdf_format="html", log_callback=None):
    base_url = "https://www.federalregister.gov/api/v1/articles.json"
    encoded_query = urllib.parse.quote(ad_number)
    
    url = (
        f"{base_url}?"
        f"conditions[agencies][]=federal-aviation-administration&"
        f"conditions[type][]=RULE&"
        f"conditions[term]={encoded_query}&"
        f"per_page=100&"
        f"fields[]=pdf_url&fields[]=document_number&fields[]=title&fields[]=body_html_url"
    )
    
    try:
        if log_callback: log_callback(f"Searching API for: {ad_number}...")
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode('utf-8'))
            results = data.get('results', [])
            
            if not results:
                if log_callback: log_callback(f" Not found.\n")
                return False
            
            # Use the first result assuming the search matched the AD
            # Ideally, we should check docket_ids to ensure exact match, but this works generally
            # for targeted AD queries in the FR.
            article = results[0]
            
            doc_num = article.get('document_number')
            pdf_url = article.get('pdf_url')
            html_url = article.get('body_html_url')
            clean_ad_num = "".join([c for c in ad_number if c.isalpha() or c.isdigit() or c in ('-', '_')]).strip()
            downloads_dir = os.path.join(os.path.expanduser('~'), 'Downloads')

            if pdf_format == "original":
                if not pdf_url:
                    if log_callback: log_callback(f" No original PDF available.\n")
                    return False
                    
                if log_callback: log_callback(f" Downloading Original PDF...\n")
                pdf_path = os.path.join(downloads_dir, f"{clean_ad_num}_original.pdf")
                
                pdf_req = urllib.request.Request(pdf_url)
                with urllib.request.urlopen(pdf_req) as pdf_response:
                    with open(pdf_path, 'wb') as f:
                        f.write(pdf_response.read())
                if log_callback: log_callback(f"  -> Saved to {pdf_path}\n")
                return True
                
            else: # HTML / Clean format
                if not html_url:
                    if log_callback: log_callback(f" No HTML content available.\n")
                    return False
                    
                if log_callback: log_callback(f" Downloading and Formatting HTML...\n")
                pdf_path = os.path.join(downloads_dir, f"AD {clean_ad_num}.pdf")
                # Write temp HTML to system temp dir (no spaces in path) so Edge
                # can reliably load it.  Paths with spaces cause Edge headless to
                # render a "file not found" error page instead of the actual content.
                temp_html_path = os.path.join(tempfile.gettempdir(), f"temp_{clean_ad_num}.html")
                
                with urllib.request.urlopen(urllib.request.Request(html_url)) as html_resp:
                    html_content = html_resp.read().decode('utf-8')

                import re
                match = re.search(r'(<h1[^>]*>\s*PART 39.*?AIRWORTHINESS DIRECTIVES\s*</h1>)', html_content, re.IGNORECASE | re.DOTALL)
                if match:
                    html_content = html_content[match.start():]
                else:
                    idx = html_content.find("PART 39&mdash;AIRWORTHINESS DIRECTIVES")
                    if idx != -1:
                        start_h1 = html_content.rfind("<h1", 0, idx)
                        if start_h1 != -1:
                            html_content = html_content[start_h1:]

                # Remove inline "( printed page NNNNN)" markers (Federal Register artifact).
                # These appear mid-sentence inside existing <p> tags, not as standalone elements.
                html_content = re.sub(
                    r'\(\s*printed\s+page\s+\d+\s*\)',
                    '',
                    html_content,
                    flags=re.IGNORECASE
                )

                full_html = f"""
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="utf-8">
                    <title>AD {clean_ad_num}</title>
                    <style>
                        @page {{
                            margin: 0.6in 0.75in;
                        }}
                        body {{ 
                            font-family: "Times New Roman", Times, serif; 
                            font-size: 9.5pt; 
                            line-height: 1.15; 
                            color: #000; 
                            text-align: justify; 
                            column-count: 2;
                            column-gap: 0.35in;
                        }}
                        h1, .document-heading {{ 
                            font-family: Arial, Helvetica, sans-serif; 
                            font-size: 12pt; 
                            font-weight: bold; 
                            text-transform: uppercase; 
                            margin-top: 14pt; 
                            margin-bottom: 8pt; 
                            text-align: left;
                            border: none;
                            padding: 0;
                        }}
                        h2, h3, h4, h5 {{ 
                            font-family: "Times New Roman", Times, serif; 
                            font-weight: bold; 
                            text-align: left; 
                            margin-top: 10pt; 
                            margin-bottom: 3pt;
                            font-size: 9.5pt;
                        }}
                        p {{ margin-top: 0; margin-bottom: 4pt; text-indent: 1.5em; }}
                        p.indent-0, p.no-indent {{ text-indent: 0; }}
                        ul, ol {{ margin-top: 0; margin-bottom: 4pt; padding-left: 2em; }}
                        li p {{ text-indent: 0; }}
                        a {{ color: #000; text-decoration: none; }}
                    </style>
                </head>
                <body>
                    {html_content}
                </body>
                </html>
                """

                with open(temp_html_path, 'w', encoding='utf-8') as f:
                    f.write(full_html)

                edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
                if not os.path.exists(edge_path):
                    edge_path = r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"

                try:
                    # Edge requires a strict file:/// URI with forward slashes 
                    # when running from inside a PyInstaller EXE.
                    html_uri = f"file:///{temp_html_path.replace(os.sep, '/')}"
                    
                    # Format the path explicitly as a URI with forward slashes. Pyinstaller 
                    # environment variables notoriously break Chromium's ability to parse
                    # bare Windows absolute paths.
                    
                    cmd = [
                        edge_path, 
                        "--headless", 
                        "--disable-gpu", 
                        "--no-sandbox",
                        "--allow-file-access-from-files",
                        "--no-pdf-header-footer",
                        f"--print-to-pdf={pdf_path}", 
                        html_uri
                    ]
                    
                    # Prevent [WinError 6] The handle is invalid in PyInstaller windowed mode
                    creationflags = 0
                    if os.name == 'nt':
                        creationflags = subprocess.CREATE_NO_WINDOW
                        
                    subprocess.run(
                        cmd, 
                        check=True, 
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, 
                        stderr=subprocess.PIPE,
                        creationflags=creationflags
                    )
                    
                    if log_callback: log_callback(f"  -> Saved clean PDF to {pdf_path}\n")
                except subprocess.CalledProcessError as e:
                    if log_callback: log_callback(f" Failed to render PDF via Edge (Process Error): {e}\n")
                    return False
                except Exception as e:
                    if log_callback: log_callback(f" Failed to render PDF via Edge: {e}\n")
                    return False
                finally:
                    if os.path.exists(temp_html_path):
                        os.remove(temp_html_path)
                
                return True
            
    except Exception as e:
        if log_callback: log_callback(f" Error: {e}\n")
        return False

class ADfetcherApp:
    def __init__(self, root):
        self.root = root
        self.root.title("FAA AD PDF Fetcher")
        self.root.geometry("600x400")
        self.root.minsize(500, 300)
        self.create_widgets()

    def create_widgets(self):
        input_frame = ttk.LabelFrame(self.root, text="AD Numbers to Download", padding=(10, 10))
        input_frame.pack(fill=tk.X, padx=10, pady=10)
        
        ttk.Label(input_frame, text="Comma-separated AD numbers\n(e.g., 2020-15-14, 2018-04-07):").pack(anchor=tk.W)
        self.ads_text = tk.Text(input_frame, height=3, width=50)
        self.ads_text.pack(fill=tk.X, pady=5)
        
        self.format_var = tk.StringVar(value="html")
        ttk.Radiobutton(input_frame, text="Clean PDF (from HTML)", variable=self.format_var, value="html").pack(anchor=tk.W, pady=(5,0))
        ttk.Radiobutton(input_frame, text="Original PDF (from FAA)", variable=self.format_var, value="original").pack(anchor=tk.W)
        
        self.run_btn = ttk.Button(input_frame, text="Download PDFs", command=self.start_download)
        self.run_btn.pack(anchor=tk.E, pady=5)
        
        log_frame = ttk.LabelFrame(self.root, text="Download Log", padding=(10, 10))
        log_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=(0, 10))
        
        self.log_text = scrolledtext.ScrolledText(log_frame, wrap=tk.WORD)
        self.log_text.pack(fill=tk.BOTH, expand=True)

    def log(self, message):
        self.log_text.insert(tk.END, message)
        self.log_text.see(tk.END)
        self.root.update_idletasks()
        
    def start_download(self):
        # Disable button during execution
        self.run_btn.config(state=tk.DISABLED)
        self.log_text.delete(1.0, tk.END)
        
        input_urls = self.ads_text.get(1.0, tk.END).strip()
        if not input_urls:
            messagebox.showwarning("Input Error", "Please enter at least one AD number.")
            self.run_btn.config(state=tk.NORMAL)
            return
            
        ad_list = [ad.strip() for ad in input_urls.split(',') if ad.strip()]
        
        if not ad_list:
            messagebox.showwarning("Input Error", "No valid AD numbers found.")
            self.run_btn.config(state=tk.NORMAL)
            return
            
        pdf_format = self.format_var.get()
        self.log(f"Starting download for {len(ad_list)} AD(s) to the local folder ({pdf_format} format)...\n\n")
        
        # Run in a background thread
        thread = threading.Thread(target=self.run_download_process, args=(ad_list, pdf_format))
        thread.daemon = True
        thread.start()
        
    def run_download_process(self, ad_list, pdf_format):
        success_count = 0
        for ad in ad_list:
            if fetch_ad_pdf(ad, pdf_format, log_callback=self.log):
                success_count += 1
                
        self.log(f"\nFinished. Successfully downloaded {success_count} of {len(ad_list)} PDFs.\n")
        messagebox.showinfo("Complete", f"Download finished.\nSuccessfully downloaded {success_count}/{len(ad_list)} PDFs.")
        self.root.after(0, lambda: self.run_btn.config(state=tk.NORMAL))

def main():
    root = tk.Tk()
    app = ADfetcherApp(root)
    root.lift()
    root.attributes('-topmost',True)
    root.after_idle(root.attributes,'-topmost',False)
    root.mainloop()

if __name__ == "__main__":
    main()
